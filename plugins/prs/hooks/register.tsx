import { parseRemote, branchName, prWebUrl } from './lib/git';
import type { AdoRepoContext, GithubRepoContext, RepoContext } from './lib/git';
import { adoBaseUrl, toPullRequestSummary, isSignInPage, tenantFromSignIn, ADO_API_VERSION, ADO_RESOURCE_ID } from './lib/ado';
import type { PullRequestSummary, PullRequestDetail } from './lib/ado';
import { buildFileTreeRows } from './lib/tree';
import type { FileChange } from './lib/tree';
import { cleanUnifiedDiff } from './lib/diff';

// Checked against the real generated claude-code.d.ts (via /plugin-types) —
// see README.md for what that changed vs. the first draft. Every `$` call
// stays a top-level function declaration in this file on purpose: `claude
// plugin validate` requires `$` to be followed only through functions
// declared at the top of the hooks module, never through an imported helper
// or a function nested inside another.

const TOKEN_STORE_KEY = 'prs:ado-token';
const TENANT_STORE_KEY = 'prs:ado-tenant';
const DIRS_STORE_KEY = 'prs:dirs';
const PANE_ID = 'prs';
const MAX_DIFF_CHARS = 9000; // Markdown elements cap at 10000 chars

type RepoGroup = { label: string; root: string; ctx: RepoContext };

type CommitInfo = { sha: string; subject: string; body: string };

type ReviewTab = 'files' | 'commits';

type BrowserGroup = { group: RepoGroup; prs: PullRequestSummary[]; error?: string };

type ViewState =
  | { mode: 'error'; message: string }
  | { mode: 'browser'; groups: BrowserGroup[] }
  | {
      mode: 'review';
      group: RepoGroup;
      detail: PullRequestDetail;
      files: FileChange[];
      commits: CommitInfo[];
      activeTab: ReviewTab;
      expandedShas: Set<string>;
      selectedPath: string | null;
      diffCache: Map<string, string>;
      loadingDiff: boolean;
      fetchMessage: string | null;
    };

let currentView: ViewState | null = null;
const repoRegistry = new Map<string, RepoGroup>();
// Repo roots collapsed in the browser; module state, so a reload expands all.
const collapsedRoots = new Set<string>();

function repoLabel(ctx: RepoContext): string {
  return ctx.provider === 'github' ? `${ctx.github.owner}/${ctx.github.repo}` : `${ctx.ado.project}/${ctx.ado.repo}`;
}

function parseArgs(e: any): string {
  const raw = e.args ?? '';
  return typeof raw === 'string' ? raw.trim() : '';
}

function ttlMinutesFrom(options: any): number {
  const parsed = Number(options?.tokenTtlMinutes ?? '45');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 45;
}

function summaryText(view: ViewState | null): string {
  if (!view) return '/prs: nothing to show';
  if (view.mode === 'error') return `/prs: ${view.message}`;
  if (view.mode === 'browser') {
    const total = view.groups.reduce((n, g) => n + g.prs.length, 0);
    return `/prs: ${total} open PR(s) across ${view.groups.length} repo(s)`;
  }
  return `/prs ${view.detail.pullRequestId}: ${view.detail.title}`;
}

// --- process / git ----------------------------------------------------

async function run(
  $: any,
  argv: string[],
  cwd?: string,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const init = { ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) };
  return $.process.run(argv, Object.keys(init).length ? init : undefined);
}

async function resolveRepoContext($: any, dir: string): Promise<{ root: string; ctx: RepoContext } | null> {
  const toplevel = await run($, ['git', 'rev-parse', '--show-toplevel'], dir);
  if (toplevel.exitCode !== 0) return null;
  const root = toplevel.stdout.trim();
  const remote = await run($, ['git', 'remote', 'get-url', 'origin'], root);
  if (remote.exitCode !== 0) return null;
  const ctx = parseRemote(remote.stdout.trim());
  if (!ctx) return null;
  return { root, ctx };
}

async function sessionCwd($: any): Promise<string | undefined> {
  return $.session.cwd().catch(() => undefined);
}

async function ensureRepoGroup($: any, dir?: string): Promise<RepoGroup | null> {
  const where = dir ?? (await sessionCwd($));
  if (!where) return null;
  const resolved = await resolveRepoContext($, where);
  if (!resolved) return null;
  const existing = repoRegistry.get(resolved.root);
  if (existing) return existing;
  const group: RepoGroup = { label: repoLabel(resolved.ctx), root: resolved.root, ctx: resolved.ctx };
  repoRegistry.set(resolved.root, group);
  return group;
}

async function currentBranch($: any, cwd: string): Promise<string | null> {
  const res = await run($, ['git', 'branch', '--show-current'], cwd);
  const name = res.stdout.trim();
  return res.exitCode === 0 && name ? name : null;
}

// The pane runs git with no terminal, so git can't ask for a password. For ADO,
// hand git the same az token the REST calls use, through env-only git config
// (not argv, so it stays out of the process list).
async function fetchBranches(
  $: any,
  group: RepoGroup,
  ttlMinutes: number,
  branches: string[],
): Promise<{ ok: boolean; message?: string }> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  if (group.ctx.provider === 'ado') {
    const tenant = await resolveAdoTenant($, group.ctx.ado.org);
    const token = await getAdoAccessToken($, ttlMinutes, tenant);
    Object.assign(env, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
    });
  }
  const res = await run($, ['git', 'fetch', 'origin', ...branches], group.root, env);
  return res.exitCode === 0 ? { ok: true } : { ok: false, message: res.stderr.trim().split('\n').pop() };
}

async function gitDiffFiles($: any, root: string, target: string, source: string): Promise<FileChange[]> {
  const range = `origin/${target}...origin/${source}`;
  const [statusRes, numstatRes] = await Promise.all([
    run($, ['git', 'diff', '--name-status', range], root),
    run($, ['git', 'diff', '--numstat', range], root),
  ]);
  if (statusRes.exitCode !== 0) return [];

  const counts = new Map<string, { added: number | null; deleted: number | null }>();
  if (numstatRes.exitCode === 0) {
    for (const line of numstatRes.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [addedStr, deletedStr, ...rest] = trimmed.split('\t');
      counts.set(rest.join('\t'), {
        added: addedStr === '-' ? null : Number(addedStr),
        deleted: deletedStr === '-' ? null : Number(deletedStr),
      });
    }
  }

  return statusRes.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line): FileChange => {
      const [status, ...rest] = line.split('\t');
      const path = rest.join('\t');
      const count = counts.get(path);
      return { path, status, added: count?.added ?? null, deleted: count?.deleted ?? null };
    });
}

async function gitDiffForFile($: any, root: string, target: string, source: string, path: string): Promise<string> {
  const res = await run($, ['git', 'diff', `origin/${target}...origin/${source}`, '--', path], root);
  return cleanUnifiedDiff(res.stdout);
}

const RECORD_SEP = '\x1e';
const FIELD_SEP = '\x1f';

/** Commits unique to the source branch (oldest first), the same way `gh`/ADO's
 * own "Commits" tab lists a PR — from git log, not another provider API call. */
async function gitCommitsBetween($: any, root: string, target: string, source: string): Promise<CommitInfo[]> {
  const format = `%H${FIELD_SEP}%s${FIELD_SEP}%b${RECORD_SEP}`;
  const res = await run($, ['git', 'log', '--reverse', `--format=${format}`, `origin/${target}..origin/${source}`], root);
  if (res.exitCode !== 0) return [];
  return res.stdout
    .split(RECORD_SEP)
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec): CommitInfo => {
      const [sha, subject, body] = rec.split(FIELD_SEP);
      return { sha: sha ?? '', subject: subject ?? '', body: (body ?? '').trim() };
    });
}

// --- Azure DevOps REST (PR metadata only; diffs come from git) --------

// The org's Entra tenant, found by asking ADO anonymously. az's default account
// may sit in a different tenant, and a token from there gets a sign-in page.
async function resolveAdoTenant($: any, org: string): Promise<string | undefined> {
  const key = `${TENANT_STORE_KEY}:${org}`;
  const cached = (await $.store.get(key)) as string | undefined;
  if (cached) return cached;

  const res = await $.http.fetch(`https://dev.azure.com/${encodeURIComponent(org)}/_apis/connectionData`);
  const tenant = tenantFromSignIn(res);
  if (tenant) await $.store.set(key, tenant);
  return tenant;
}

async function getAdoAccessToken($: any, ttlMinutes: number, tenant: string | undefined): Promise<string> {
  const key = `${TOKEN_STORE_KEY}:${tenant ?? 'default'}`;
  const cached = (await $.store.get(key)) as { token: string; expiresAt: number } | undefined;
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.token;

  const loginCheck = await run($, ['az', 'account', 'show']);
  if (loginCheck.exitCode !== 0) {
    throw new Error('Not logged into Azure CLI. Run `az login` in a terminal, then retry /prs.');
  }

  const tokenRes = await run($, [
    'az', 'account', 'get-access-token',
    '--resource', ADO_RESOURCE_ID,
    ...(tenant ? ['--tenant', tenant] : []),
    '--query', 'accessToken',
    '-o', 'tsv',
  ]);
  const token = tokenRes.stdout.trim();
  if (tokenRes.exitCode !== 0 || !token) {
    const hint = tenant ? ` Run \`az login --tenant ${tenant}\` in a terminal, then retry /prs.` : '';
    throw new Error(`Failed to get an Azure DevOps access token via az CLI: ${tokenRes.stderr.trim()}${hint}`);
  }

  await $.store.set(key, { token, expiresAt: now + ttlMinutes * 60_000 });
  return token;
}

async function adoJson($: any, ttlMinutes: number, ctx: AdoRepoContext, url: string): Promise<any> {
  const tenant = await resolveAdoTenant($, ctx.org);
  const token = await getAdoAccessToken($, ttlMinutes, tenant);
  const res = await $.http.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Azure DevOps API ${res.status} on ${url.split('?')[0]}: ${(res.text ?? '').slice(0, 300)}`);
  }
  if (isSignInPage(res)) {
    const login = tenant ? `az login --tenant ${tenant}` : 'az login';
    throw new Error(
      `Azure DevOps sent a sign-in page instead of data for org "${ctx.org}", so the az CLI account can't access it. ` +
        `Run \`${login}\` with an account in that org, then retry /prs.`,
    );
  }
  return JSON.parse(res.text);
}

async function listAdoPullRequests($: any, ctx: AdoRepoContext, ttlMinutes: number): Promise<PullRequestSummary[]> {
  const url = `${adoBaseUrl(ctx)}/pullrequests?searchCriteria.status=active&api-version=${ADO_API_VERSION}`;
  const body = await adoJson($, ttlMinutes, ctx, url);
  return (body.value ?? []).map(toPullRequestSummary);
}

async function getAdoPullRequest($: any, ctx: AdoRepoContext, ttlMinutes: number, id: number): Promise<PullRequestDetail> {
  const url = `${adoBaseUrl(ctx)}/pullrequests/${id}?api-version=${ADO_API_VERSION}`;
  const pr = await adoJson($, ttlMinutes, ctx, url);
  return { ...toPullRequestSummary(pr), description: pr.description ?? '' };
}

// --- GitHub (via the already-authenticated `gh` CLI; no token plumbing needed) --

function toGithubSummary(pr: any): PullRequestSummary {
  return {
    pullRequestId: pr.number,
    title: pr.title,
    status: (pr.state ?? 'open').toLowerCase(),
    createdBy: pr.author?.login ?? 'unknown',
    sourceRefName: `refs/heads/${pr.headRefName}`,
    targetRefName: `refs/heads/${pr.baseRefName}`,
    creationDate: pr.createdAt,
    isDraft: !!pr.isDraft,
  };
}

async function listGithubPullRequests($: any, gh: GithubRepoContext): Promise<PullRequestSummary[]> {
  const res = await run($, [
    'gh', 'pr', 'list',
    '--repo', `${gh.owner}/${gh.repo}`,
    '--state', 'open',
    '--json', 'number,title,author,headRefName,baseRefName,createdAt,isDraft',
  ]);
  if (res.exitCode !== 0) throw new Error(`gh pr list failed: ${(res.stderr || res.stdout).trim()}`);
  return (JSON.parse(res.stdout) as any[]).map(toGithubSummary);
}

async function getGithubPullRequest($: any, gh: GithubRepoContext, id: number): Promise<PullRequestDetail> {
  const res = await run($, [
    'gh', 'pr', 'view', String(id),
    '--repo', `${gh.owner}/${gh.repo}`,
    '--json', 'number,title,author,headRefName,baseRefName,createdAt,isDraft,state,body',
  ]);
  if (res.exitCode !== 0) throw new Error(`gh pr view failed: ${(res.stderr || res.stdout).trim()}`);
  const pr = JSON.parse(res.stdout);
  return { ...toGithubSummary(pr), description: pr.body ?? '' };
}

// --- the session's repos -------------------------------------------------

// Directories the session works in beyond its cwd. /add-dir raises
// DirectoryAdded, kept per session in the store so a reload keeps them; the
// transcript's /add-dir lines and the settings' additionalDirectories cover
// what was added before this module loaded.
async function rememberDir($: any, dir: string): Promise<void> {
  const id = await $.session.id().catch(() => 'unknown');
  const key = `${DIRS_STORE_KEY}:${id}`;
  const dirs = ((await $.store.get(key)) as string[] | undefined) ?? [];
  if (!dirs.includes(dir)) await $.store.set(key, [...dirs, dir]);
}

async function storedDirs($: any): Promise<string[]> {
  const id = await $.session.id().catch(() => 'unknown');
  return ((await $.store.get(`${DIRS_STORE_KEY}:${id}`).catch(() => undefined)) as string[] | undefined) ?? [];
}

const ADD_DIR_IN_TRANSCRIPT = /<command-name>\/add-dir<\/command-name>[\s\S]*?<command-args>([^<]+)<\/command-args>/g;

async function transcriptDirs($: any): Promise<string[]> {
  const messages = ((await $.session.messages().catch(() => [])) ?? []) as { role: string; text: string }[];
  const dirs: string[] = [];
  for (const m of messages) {
    if (m.role !== 'user' || !m.text?.includes('/add-dir')) continue;
    for (const match of m.text.matchAll(ADD_DIR_IN_TRANSCRIPT)) {
      const dir = match[1]?.trim();
      if (dir) dirs.push(dir);
    }
  }
  return dirs;
}

async function settingsDirs($: any): Promise<string[]> {
  const settings = (await $.settings.read().catch(() => ({}))) as any;
  const dirs = settings?.permissions?.additionalDirectories;
  return Array.isArray(dirs) ? dirs.filter((d: unknown): d is string => typeof d === 'string') : [];
}

// Every GitHub or ADO repo the session can see, the cwd's first.
async function sessionRepoGroups($: any): Promise<RepoGroup[]> {
  const cwd = await sessionCwd($);
  const extra = [...(await storedDirs($)), ...(await transcriptDirs($)), ...(await settingsDirs($))];
  const dirs = [...new Set([...(cwd ? [cwd] : []), ...extra.map((d) => d.replace(/\/+$/, '') || '/')])];
  const groups: RepoGroup[] = [];
  for (const dir of dirs) {
    const group = await ensureRepoGroup($, dir);
    if (group && !groups.some((g) => g.root === group.root)) groups.push(group);
  }
  for (const group of repoRegistry.values()) {
    if (!groups.some((g) => g.root === group.root)) groups.push(group);
  }
  return groups;
}

async function loadBrowser($: any, ttlMinutes: number, groups: RepoGroup[]): Promise<ViewState> {
  const loaded: BrowserGroup[] = [];
  for (const group of groups) {
    try {
      loaded.push({ group, prs: await listPullRequests($, group, ttlMinutes) });
    } catch (err: any) {
      loaded.push({ group, prs: [], error: err?.message ?? String(err) });
    }
  }
  return { mode: 'browser', groups: loaded };
}

// --- provider dispatch ------------------------------------------------

async function listPullRequests($: any, group: RepoGroup, ttlMinutes: number): Promise<PullRequestSummary[]> {
  return group.ctx.provider === 'github'
    ? listGithubPullRequests($, group.ctx.github)
    : listAdoPullRequests($, group.ctx.ado, ttlMinutes);
}

async function getPullRequest($: any, group: RepoGroup, ttlMinutes: number, id: number): Promise<PullRequestDetail> {
  return group.ctx.provider === 'github'
    ? getGithubPullRequest($, group.ctx.github, id)
    : getAdoPullRequest($, group.ctx.ado, ttlMinutes, id);
}

// --- view construction --------------------------------------------------

async function openReview($: any, ttlMinutes: number, group: RepoGroup, prId: number): Promise<void> {
  const detail = await getPullRequest($, group, ttlMinutes, prId);
  const source = branchName(detail.sourceRefName);
  const target = branchName(detail.targetRefName);

  const fetch = await fetchBranches($, group, ttlMinutes, [source, target]);
  const fetched = fetch.ok;
  const [files, commits] = fetched
    ? await Promise.all([gitDiffFiles($, group.root, target, source), gitCommitsBetween($, group.root, target, source)])
    : [[], []];

  // Read-only on the repo: no checkout, branch or worktree. The files and
  // commits come from the fetched origin/* refs, never the working tree.
  const fetchMessage = fetched
    ? null
    : `couldn't fetch ${source} and ${target} from origin${fetch.message ? `: ${fetch.message}` : ''}`;

  const view: ViewState = {
    mode: 'review',
    group,
    detail,
    files,
    commits,
    activeTab: 'files',
    expandedShas: new Set(),
    selectedPath: files[0]?.path ?? null,
    diffCache: new Map(),
    loadingDiff: false,
    fetchMessage,
  };
  currentView = view;

  if (view.selectedPath) await loadDiffForSelected($, view);
}

async function goBackToBrowser($: any, ttlMinutes: number): Promise<void> {
  currentView = await loadBrowser($, ttlMinutes, await sessionRepoGroups($));
}

async function loadDiffForSelected($: any, view: Extract<ViewState, { mode: 'review' }>): Promise<void> {
  if (!view.selectedPath || view.diffCache.has(view.selectedPath)) return;
  view.loadingDiff = true;
  try {
    const diffText = await gitDiffForFile(
      $,
      view.group.root,
      branchName(view.detail.targetRefName),
      branchName(view.detail.sourceRefName),
      view.selectedPath,
    );
    view.diffCache.set(view.selectedPath, diffText);
  } finally {
    view.loadingDiff = false;
  }
}

// --- the PR list's look ---------------------------------------------------
// Raw hex, not theme keys, so it reads the same in either terminal theme. The
// background is a vertical gradient, ink → dusty plum, painted one solid row
// at a time (there's no gradient prop); the pastels on top stay muted.
const BG_FROM = [0x17, 0x19, 0x21];
const BG_TO = [0x3a, 0x30, 0x42];
const REPO_TINTS = ['#a9c4a4', '#b9aedc', '#e2b9a0', '#9fbfd6', '#d6a9b8']; // sage, lavender, peach, sky, rose
const RULE_COLOR = '#5d566e';
const HAIRLINE_COLOR = '#4a4558';
const ERROR_COLOR = '#d99a9a';
const ROW_HOVER = { backgroundColor: '#2d2a3a', color: '#e8e3f2' } as const;

function gradientAt(row: number, rows: number): string {
  const t = Math.pow(Math.min(1, Math.max(0, row / Math.max(1, rows - 1))), 1.3);
  return '#' + BG_FROM.map((from, i) => Math.round(from + (BG_TO[i]! - from) * t).toString(16).padStart(2, '0')).join('');
}

// one pane line, cut to fit: a row that wrapped would throw the gradient off
function fit(label: string, columns: number): string {
  const room = Math.max(8, columns - 2);
  return label.length > room ? label.slice(0, room - 1) + '…' : label;
}

function renderBrowser($: any, e: any, ttlMinutes: number, view: Extract<ViewState, { mode: 'browser' }>) {
  const { Box, Text, Button } = $.ui.resolve(e);
  const columns = Math.max(20, (e.props as any)?.bodyColumns ?? 60);
  const bodyRows = Math.max(1, (e.props as any)?.scroll?.bodyRows ?? 30);

  // every entry is exactly one line; its background comes from its position
  const rows: { key: string; hover?: boolean; draw: () => any }[] = [];
  if (view.groups.length > 1) {
    rows.push({
      key: 'row:toolbar',
      draw: () => (
        <Box flexDirection="row" columnGap={2}>
          <Button
            key="expand-all"
            plain
            label="⊞ Expand all"
            dimColor
            onPress={() => {
              collapsedRoots.clear();
              $.ui.invalidate('ui.render');
            }}
          />
          <Button
            key="collapse-all"
            plain
            label="⊟ Collapse all"
            dimColor
            onPress={() => {
              for (const g of view.groups) collapsedRoots.add(g.group.root);
              $.ui.invalidate('ui.render');
            }}
          />
        </Box>
      ),
    });
  }
  view.groups.forEach(({ group, prs, error }, i) => {
    const tint = REPO_TINTS[i % REPO_TINTS.length]!;
    const collapsed = collapsedRoots.has(group.root);
    if (rows.length > 0) {
      rows.push({ key: `row:rule:${group.root}`, draw: () => <Text color={RULE_COLOR}>{'─'.repeat(columns - 2)}</Text> });
    }
    rows.push({
      key: `row:head:${group.root}`,
      draw: () => (
        <Box flexDirection="row" columnGap={1}>
          <Button
            key={`toggle:${group.root}`}
            plain
            label={collapsed ? '▸' : '▾'}
            onPress={() => {
              if (collapsed) collapsedRoots.delete(group.root);
              else collapsedRoots.add(group.root);
              $.ui.invalidate('ui.render');
            }}
          />
          <Text bold color={tint}>{group.label}</Text>
          <Text dimColor>{error ? '· error' : `· ${prs.length} open`}</Text>
        </Box>
      ),
    });
    if (collapsed) return;
    if (error) {
      rows.push({ key: `row:error:${group.root}`, draw: () => <Text color={ERROR_COLOR}>{fit(`  ${error}`, columns)}</Text> });
    } else if (prs.length === 0) {
      rows.push({ key: `row:empty:${group.root}`, draw: () => <Text dimColor>{'  no active pull requests'}</Text> });
    }
    prs.forEach((pr, j) => {
      if (j > 0) {
        const width = Math.max(6, Math.floor(columns * 0.3));
        const pad = ' '.repeat(Math.max(0, Math.floor((columns - 2 - width) / 2)));
        rows.push({
          key: `row:hair:${group.root}:${pr.pullRequestId}`,
          draw: () => <Text color={HAIRLINE_COLOR}>{pad + '┄'.repeat(width)}</Text>,
        });
      }
      rows.push({
        key: `row:pr:${group.root}:${pr.pullRequestId}`,
        hover: true,
        draw: () => (
          <Button
            key={`open:${group.root}:${pr.pullRequestId}`}
            plain
            hover={ROW_HOVER}
            label={fit(`  #${pr.pullRequestId}  ${pr.title} — ${pr.createdBy}${pr.isDraft ? ' (draft)' : ''}`, columns)}
            onPress={() => {
              openReview($, ttlMinutes, group, pr.pullRequestId).then(() => $.ui.invalidate('ui.render'));
            }}
          />
        ),
      });
    });
  });

  // filler rows carry the gradient to the pane's bottom under a short list
  const total = Math.max(bodyRows, rows.length);
  for (let n = rows.length; n < total; n++) rows.push({ key: `row:fill:${n}`, draw: () => <Text> </Text> });

  return (
    // sized to the pane: a Box only paints its background over the cells it occupies
    <Box flexDirection="column" width={columns}>
      {rows.map((row, n) => (
        <Box
          key={row.key}
          height={1}
          paddingX={1}
          backgroundColor={gradientAt(n, total)}
          {...(row.hover ? { hover: { backgroundColor: ROW_HOVER.backgroundColor } } : {})}
        >
          {row.draw()}
        </Box>
      ))}
    </Box>
  );
}

function renderView($: any, e: any, options: any, view: ViewState) {
  const { Box, Text, Markdown, Button } = $.ui.resolve(e);
  const ttlMinutes = ttlMinutesFrom(options);
  // A visible section rule — `gap` on Box produced no visible blank row here.
  const dividerWidth = Math.max(1, (e.props as any)?.bodyColumns ?? 60);
  const Divider = () => <Text dimColor>{'─'.repeat(dividerWidth)}</Text>;

  if (view.mode === 'error') {
    return <Markdown text={`**/prs error:** ${view.message}`} />;
  }

  if (view.mode === 'browser') {
    return renderBrowser($, e, ttlMinutes, view);
  }

  const tabButton = (tab: ReviewTab, label: string) => (
    <Button
      key={`tab:${tab}`}
      plain
      label={view.activeTab === tab ? `● ${label}` : label}
      onPress={() => {
        view.activeTab = tab;
        $.ui.invalidate('ui.render');
      }}
    />
  );

  let content: any;
  if (view.activeTab === 'commits') {
    content = (
      <Box flexDirection="column">
        {view.commits.length === 0 && <Markdown text="_no commits on this branch_" />}
        {view.commits.map((c, i) => {
          const expanded = view.expandedShas.has(c.sha);
          return (
            <Box key={`commit:${c.sha}`} flexDirection="column">
              {i > 0 && <Divider />}
              <Button
                key={`commit:${c.sha}`}
                plain
                label={`${c.sha.slice(0, 7)}  ${c.subject}`}
                onPress={() => {
                  if (expanded) view.expandedShas.delete(c.sha);
                  else view.expandedShas.add(c.sha);
                  $.ui.invalidate('ui.render');
                }}
              />
              {expanded && (c.body ? <Markdown text={c.body} /> : <Text dimColor>  (no description)</Text>)}
            </Box>
          );
        })}
      </Box>
    );
  } else {
    const diffBody = view.selectedPath ? view.diffCache.get(view.selectedPath) : undefined;
    const truncated = !!diffBody && diffBody.length > MAX_DIFF_CHARS;
    const diffText = diffBody
      ? '```diff\n' + diffBody.slice(0, MAX_DIFF_CHARS) + (truncated ? '\n… (truncated)' : '') + '\n```'
      : view.loadingDiff
        ? '_loading diff…_'
        : '_select a file_';

    const treeRows = buildFileTreeRows(view.files);

    content = (
      <Box flexDirection="column">
        <Box flexDirection="column">
          {treeRows.map((row) =>
            row.kind === 'dir' ? (
              <Text key={`dir:${row.depth}:${row.name}`} dimColor>
                {'  '.repeat(row.depth) + row.name + '/'}
              </Text>
            ) : (
              <Box key={`file:${row.file.path}`} flexDirection="row" columnGap={1}>
                <Button
                  key={`file:${row.file.path}`}
                  plain
                  label={
                    '  '.repeat(row.depth) +
                    row.name +
                    (row.file.path === view.selectedPath ? ' •' : '')
                  }
                  onPress={() => {
                    view.selectedPath = row.file.path;
                    loadDiffForSelected($, view).then(() => $.ui.invalidate('ui.render'));
                  }}
                />
                {row.file.added !== null && <Text color="green">+{row.file.added}</Text>}
                {row.file.deleted !== null && <Text color="red">-{row.file.deleted}</Text>}
                {row.file.added === null && <Text dimColor>({row.file.status})</Text>}
              </Box>
            ),
          )}
        </Box>
        <Divider />
        <Markdown text={diffText} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Button
        key="back"
        plain
        label="‹ back to PR list"
        onPress={() => {
          goBackToBrowser($, ttlMinutes).then(() => $.ui.invalidate('ui.render'));
        }}
      />
      <Divider />
      <Markdown text={`#${view.detail.pullRequestId} ${view.detail.title}`} />
      <Divider />
      <Markdown
        text={`${branchName(view.detail.sourceRefName)} → ${branchName(view.detail.targetRefName)} · ${view.detail.createdBy} · ${view.detail.status}${view.detail.isDraft ? ' · draft' : ''}`}
      />
      <Markdown text={`[↗ open PR #${view.detail.pullRequestId} in browser](${prWebUrl(view.group.ctx, view.detail.pullRequestId)})`} />
      {view.fetchMessage && (
        <>
          <Divider />
          <Text color="yellow">{view.fetchMessage}</Text>
        </>
      )}
      <Divider />
      <Markdown text={view.detail.description || '_no description_'} />
      <Divider />
      <Box flexDirection="row" columnGap={2}>
        {tabButton('files', 'Files')}
        {tabButton('commits', `Commits (${view.commits.length})`)}
      </Box>
      <Divider />
      {content}
    </Box>
  );
}

async function handleCommandRun($: any, e: any, options: any): Promise<{ text: string }> {
  const args = parseArgs(e);
  const ttlMinutes = ttlMinutesFrom(options);

  try {
    if (args === '--all') {
      const groups = await sessionRepoGroups($);
      currentView =
        groups.length === 0
          ? { mode: 'error', message: 'no GitHub or Azure DevOps repos in this session — run /prs from inside one, or /add-dir one' }
          : await loadBrowser($, ttlMinutes, groups);
    } else if (/^\d+$/.test(args)) {
      const group = await ensureRepoGroup($);
      if (!group) {
        currentView = { mode: 'error', message: "current directory isn't a GitHub or Azure DevOps repo (no parseable origin remote)" };
      } else {
        await openReview($, ttlMinutes, group, Number(args));
      }
    } else if (args.length === 0) {
      const group = await ensureRepoGroup($);
      if (!group) {
        currentView = { mode: 'error', message: "current directory isn't a GitHub or Azure DevOps repo (no parseable origin remote)" };
      } else {
        const branch = await currentBranch($, group.root);
        const prs = await listPullRequests($, group, ttlMinutes);
        const match = branch ? prs.find((pr) => branchName(pr.sourceRefName) === branch) : undefined;
        if (match) {
          await openReview($, ttlMinutes, group, match.pullRequestId);
        } else {
          currentView = await loadBrowser($, ttlMinutes, await sessionRepoGroups($));
        }
      }
    } else {
      currentView = { mode: 'error', message: `unrecognized arguments "${args}" — use /prs, /prs <id>, or /prs --all` };
    }
  } catch (err: any) {
    currentView = { mode: 'error', message: err?.message ?? String(err) };
  }

  if (currentView?.mode === 'error') {
    return { text: summaryText(currentView) };
  }

  await $.ui
    .open({ id: PANE_ID, title: 'PRs', focus: true, closeOnEscape: true })
    .catch((err: any) => $.ui.log(`prs: couldn't open the panel: ${err}`));
  return {};
}

async function handlePaneRender($: any, e: any, options: any, next: any): Promise<any> {
  if (e.requestId !== PANE_ID || !currentView) return next(e);
  return renderView($, e, options, currentView);
}

async function handleSessionStart($: any, e: any, next: any): Promise<any> {
  const r = await next(e);
  await $.command
    .register({
      name: 'prs',
      description: 'Browse and review pull requests across the session\'s repos',
      argumentHint: '[id|--all]',
    })
    .catch((err: any) => $.ui.log(`prs: /prs not registered: ${err}`));
  return r;
}

async function handleDirectoryAdded($: any, e: any, next: any): Promise<any> {
  if (typeof e.directory === 'string') await rememberDir($, e.directory).catch(() => undefined);
  return next(e);
}

export function register(on: any, options: any) {
  on('session.start', ($: any, e: any, next: any) => handleSessionStart($, e, next));
  on('command.run', { command: 'prs' }, ($: any, e: any) => handleCommandRun($, e, options));
  on('ui.render', { component: 'Pane' }, ($: any, e: any, next: any) => handlePaneRender($, e, options, next));
  on('classic.DirectoryAdded', ($: any, e: any, next: any) => handleDirectoryAdded($, e, next));
}
