import { test, expect } from 'claude-code/testing';
import { register } from './register';

const REMOTE_URL = 'https://dev.azure.com/aether-engineering/app-deployments/_git/web-frontend';

const PR_318 = {
  pullRequestId: 318,
  title: 'feat: trial campaign admin UI',
  status: 'active',
  createdBy: { displayName: 'ambareesha.vittal' },
  sourceRefName: 'refs/heads/feature/trial-campaign',
  targetRefName: 'refs/heads/main',
  creationDate: '2026-09-21',
  isDraft: false,
};

const PR_77 = {
  pullRequestId: 77,
  title: 'fix: stream timeout',
  status: 'active',
  createdBy: { displayName: 'sairaam' },
  sourceRefName: 'refs/heads/fix/stream-timeout',
  targetRefName: 'refs/heads/dev',
  creationDate: '2026-09-22',
  isDraft: false,
};

const PR_319 = { ...PR_318, pullRequestId: 319, title: 'chore: bump deps', sourceRefName: 'refs/heads/chore/deps' };

const API_REMOTE = 'https://dev.azure.com/aether-engineering/app-deployments/_git/api-backend';

const GITHUB_PR_42 = {
  number: 42,
  title: 'fix: retry flaky upload',
  author: { login: 'octocat' },
  headRefName: 'fix/retry-upload',
  baseRefName: 'main',
  createdAt: '2026-09-20T00:00:00Z',
  isDraft: false,
  state: 'OPEN',
};

const SIGN_IN_PAGE = (tenant: string) =>
  `<html><script>var u="https://login.microsoftonline.com/${tenant}/oauth2/authorize?client_id=499b84ac"</script></html>`;

// orgTenant: the Entra tenant backing the ADO org. When set, ADO only answers
// JSON to a token az minted for that tenant; any other token gets the 203
// sign-in page ADO really sends. azCalls collects every az argv.
function installMocks(
  on: any,
  opts: {
    remoteUrl?: string;
    orgTenant?: string;
    tenantDiscoverable?: boolean;
    azCalls?: string[][];
    fetchNeedsBearer?: boolean;
    fetchEnvs?: Record<string, string>[];
    // dir -> origin URL, for a session spanning several repos; the first is the session's cwd.
    repos?: Record<string, string>;
    transcript?: string[];
    gitCalls?: string[][];
  } = {},
) {
  const remoteUrl = opts.remoteUrl ?? REMOTE_URL;
  const tenantDiscoverable = opts.tenantDiscoverable ?? true;

  on('process.run', async ($: any, e: any, next: any) => {
    const [cmd, ...rest] = e.argv as string[];

    const cwd = e.init?.cwd as string | undefined;
    if (cmd === 'git') opts.gitCalls?.push(rest);
    if (cmd === 'git' && rest[0] === 'rev-parse') {
      if (!opts.repos) return { value: { exitCode: 0, stdout: '/repo\n', stderr: '' } };
      return cwd && opts.repos[cwd]
        ? { value: { exitCode: 0, stdout: cwd + '\n', stderr: '' } }
        : { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } };
    }
    if (cmd === 'git' && rest[0] === 'remote') {
      const url = opts.repos ? cwd && opts.repos[cwd] : remoteUrl;
      return url
        ? { value: { exitCode: 0, stdout: url + '\n', stderr: '' } }
        : { value: { exitCode: 2, stdout: '', stderr: 'no such remote' } };
    }
    if (cmd === 'gh' && rest[0] === 'pr' && rest[1] === 'list') {
      return { value: { exitCode: 0, stdout: JSON.stringify([GITHUB_PR_42]), stderr: '' } };
    }
    if (cmd === 'gh' && rest[0] === 'pr' && rest[1] === 'view') {
      return {
        value: { exitCode: 0, stdout: JSON.stringify({ ...GITHUB_PR_42, body: 'Retries the upload once on 5xx.' }), stderr: '' },
      };
    }
    if (cmd === 'git' && rest[0] === 'branch') {
      return { value: { exitCode: 0, stdout: 'feature/trial-campaign\n', stderr: '' } };
    }
    if (cmd === 'git' && rest[0] === 'fetch') {
      const env = (e.init?.env ?? {}) as Record<string, string>;
      opts.fetchEnvs?.push(env);
      // Like a real non-interactive git with no cached ADO credential.
      if (opts.fetchNeedsBearer && !/^Authorization: Bearer /.test(env.GIT_CONFIG_VALUE_0 ?? '')) {
        return {
          value: { exitCode: 128, stdout: '', stderr: "fatal: could not read Password for 'https://org@dev.azure.com': Device not configured" },
        };
      }
      return { value: { exitCode: 0, stdout: '', stderr: '' } };
    }
    if (cmd === 'git' && rest[0] === 'log') {
      const SEP1 = '\x1f';
      const SEP2 = '\x1e';
      const commits = [
        { sha: 'a1b2c3d4e5f6', subject: 'fix upload retry', body: 'Retries once on a 5xx before giving up.' },
        { sha: 'b2c3d4e5f6a1', subject: 'add test for retry path', body: '' },
      ];
      return {
        value: {
          exitCode: 0,
          stdout: commits.map((c) => `${c.sha}${SEP1}${c.subject}${SEP1}${c.body}${SEP2}`).join(''),
          stderr: '',
        },
      };
    }
    if (cmd === 'git' && rest[0] === 'diff' && rest.includes('--name-status')) {
      return { value: { exitCode: 0, stdout: 'M\tsrc/app.ts\nA\tsrc/new-file.ts\n', stderr: '' } };
    }
    if (cmd === 'git' && rest[0] === 'diff' && rest.includes('--numstat')) {
      return { value: { exitCode: 0, stdout: '3\t1\tsrc/app.ts\n5\t0\tsrc/new-file.ts\n', stderr: '' } };
    }
    if (cmd === 'git' && rest[0] === 'diff') {
      return {
        value: {
          exitCode: 0,
          stdout:
            'diff --git a/src/new-file.ts b/src/new-file.ts\n' +
            'index 0000000..387c90f 100644\n' +
            '--- /dev/null\n' +
            '+++ b/src/new-file.ts\n' +
            '@@ -1,2 +1,2 @@\n-old line\n+new line\n',
          stderr: '',
        },
      };
    }
    if (cmd === 'az') opts.azCalls?.push(rest);
    if (cmd === 'az' && rest.join(' ') === 'account show') {
      return { value: { exitCode: 0, stdout: '{}', stderr: '' } };
    }
    if (cmd === 'az' && rest[0] === 'account') {
      const t = rest.indexOf('--tenant');
      const token = t >= 0 ? `token-for-${rest[t + 1]}` : 'fake-token';
      return { value: { exitCode: 0, stdout: token + '\n', stderr: '' } };
    }
    return { value: { exitCode: 1, stdout: '', stderr: `unmocked argv: ${e.argv.join(' ')}` } };
  });

  on('session.cwd', async () => ({ value: opts.repos ? Object.keys(opts.repos)[0] : '/repo' }));
  on('session.messages', async () => ({ value: (opts.transcript ?? []).map((text) => ({ role: 'user', text, toolUses: [] })) }));
  on('settings.read', async () => ({ value: {} }));
  on('store.get', async () => ({ value: undefined }));
  on('store.set', async () => ({ value: undefined }));
  on('ui.open', async () => ({ value: undefined }));

  on('http.fetch', async ($: any, e: any, next: any) => {
    const url = e.url as string;
    const auth = e.init?.headers?.Authorization as string | undefined;
    const signIn = (tenant: string) => ({
      value: { status: 203, ok: true, headers: { 'content-type': 'text/html; charset=utf-8' }, text: SIGN_IN_PAGE(tenant) },
    });
    if (url.endsWith('/_apis/connectionData')) {
      return opts.orgTenant && tenantDiscoverable
        ? signIn(opts.orgTenant)
        : { value: { status: 404, ok: false, headers: {}, text: 'not found' } };
    }
    if (opts.orgTenant && auth !== `Bearer token-for-${opts.orgTenant}`) {
      return signIn(opts.orgTenant);
    }
    if (url.includes('/pullrequests?')) {
      const prs = opts.repos ? (url.includes('/repositories/api-backend/') ? [PR_77] : [PR_318, PR_319]) : [PR_318];
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ value: prs }) } };
    }
    if (/\/pullrequests\/318\?/.test(url)) {
      return {
        value: {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify({ ...PR_318, description: 'Adds the admin UI for trial campaigns.' }),
        },
      };
    }
    return { value: { status: 404, ok: false, headers: {}, text: 'not found' } };
  });
}

const PANE_PROPS = {
  title: 'PRs',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
};

test('command.run pr reports a clear error outside an ADO repo', async ($: any, on: any) => {
  register(on, {});
  on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: 'not a git repository' } }));

  const result = await $.command.run({ command: 'prs', args: '' });
  expect(result.text).toContain("isn't a GitHub or Azure DevOps repo");
});

test('bare /pr auto-detects the PR and opens a pane, with no inline text', async ($: any, on: any) => {
  register(on, {});
  installMocks(on);

  const result = await $.command.run({ command: 'prs', args: '' });
  expect(result.text).toBeUndefined();
});

test('a GitHub-remote repo lists and opens PRs via gh, not az/ADO', async ($: any, on: any) => {
  register(on, {});
  installMocks(on, { remoteUrl: 'https://github.com/octocat/widgets.git' });

  const result = await $.command.run({ command: 'prs', args: '42' });
  expect(result.text).toBeUndefined();

  const ui = await $.ui.mount({
    plugin: 'prs',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'prs',
    props: PANE_PROPS,
  });
  expect(await ui.find({ text: /retry flaky upload/ })).toBeDefined();
  expect(await ui.find({ text: /octocat/ })).toBeDefined();
  await ui.unmount();
});

test('the docked pane draws the file list and reacts to a file press', async ($: any, on: any) => {
  register(on, {});
  installMocks(on);

  await $.command.run({ command: 'prs', args: '318' });

  const ui = await $.ui.mount({
    plugin: 'prs',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'prs',
    props: PANE_PROPS,
  });

  expect(await ui.find({ text: /trial campaign admin UI/ })).toBeDefined();
  expect(await ui.find({ text: /app\.ts/ })).toBeDefined();
  expect(await ui.find({ text: /new-file\.ts/ })).toBeDefined();
  expect(await ui.find({ text: '+3' })).toBeDefined();
  expect(await ui.find({ text: '-1' })).toBeDefined();
  expect(await ui.find({ text: /^─{10,}$/ })).toBeDefined();
  expect(
    await ui.find({ text: /open PR #318 in browser.*dev\.azure\.com\/aether-engineering\/app-deployments\/_git\/web-frontend\/pullrequest\/318/ }),
  ).toBeDefined();

  await ui.press({ key: 'file:src/new-file.ts' });
  expect(await ui.find({ text: /new line/ })).toBeDefined();
  expect(await ui.find({ text: /diff --git/ })).toBeUndefined();
  expect(await ui.find({ text: /^index /m })).toBeUndefined();

  await ui.unmount();
});

test('the commits tab lists commits compactly and expands one on press', async ($: any, on: any) => {
  register(on, {});
  installMocks(on);

  await $.command.run({ command: 'prs', args: '318' });

  const ui = await $.ui.mount({
    plugin: 'prs',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'prs',
    props: PANE_PROPS,
  });

  await ui.press({ key: 'tab:commits' });
  expect(await ui.find({ text: /fix upload retry/ })).toBeDefined();
  expect(await ui.find({ text: /Retries once on a 5xx/ })).toBeUndefined();

  await ui.press({ key: 'commit:a1b2c3d4e5f6' });
  expect(await ui.find({ text: /Retries once on a 5xx/ })).toBeDefined();

  await ui.press({ key: 'commit:a1b2c3d4e5f6' });
  expect(await ui.find({ text: /Retries once on a 5xx/ })).toBeUndefined();

  await ui.unmount();
});

test('an ADO org in another Entra tenant gets a token minted for that tenant', async ($: any, on: any) => {
  register(on, {});
  const azCalls: string[][] = [];
  installMocks(on, { orgTenant: '0b3d9e34-d046-4f37-8cc3-9126231ffdb3', azCalls });

  const result = await $.command.run({ command: 'prs', args: '' });
  expect(result.text).toBeUndefined();
  const tokenCall = azCalls.find((argv) => argv.includes('get-access-token'));
  expect(tokenCall).toContain('--tenant');
  expect(tokenCall).toContain('0b3d9e34-d046-4f37-8cc3-9126231ffdb3');
});

test('a sign-in page instead of JSON is reported as an auth problem, not a parse error', async ($: any, on: any) => {
  register(on, {});
  installMocks(on, { orgTenant: '0b3d9e34-d046-4f37-8cc3-9126231ffdb3', tenantDiscoverable: false });

  const result = await $.command.run({ command: 'prs', args: '' });
  expect(result.text).not.toContain('JSON Parse');
  expect(result.text).toContain('sign-in page');
  expect(result.text).toContain('az login');
});

test('ADO git fetch authenticates with the az token instead of prompting for a password', async ($: any, on: any) => {
  register(on, {});
  const fetchEnvs: Record<string, string>[] = [];
  installMocks(on, { fetchNeedsBearer: true, fetchEnvs });

  const result = await $.command.run({ command: 'prs', args: '318' });
  expect(result.text).toBeUndefined();
  expect(fetchEnvs[0]?.GIT_TERMINAL_PROMPT).toBe('0');
  expect(fetchEnvs[0]?.GIT_CONFIG_KEY_0).toBe('http.extraHeader');
  expect(fetchEnvs[0]?.GIT_CONFIG_VALUE_0).toBe('Authorization: Bearer fake-token');

  const ui = await $.ui.mount({ plugin: 'prs', surface: 'terminal', component: 'Pane', requestId: 'prs', props: PANE_PROPS });
  expect(await ui.find({ text: /couldn't fetch/ })).toBeUndefined();
  expect(await ui.find({ text: /app\.ts/ })).toBeDefined();
});

const TWO_REPOS = { '/api': API_REMOTE, '/web': REMOTE_URL };
const ADD_DIR_WEB = '<command-name>/add-dir</command-name>\n<command-message>add-dir</command-message>\n<command-args>/web/</command-args>';

async function mountPane($: any) {
  return $.ui.mount({ plugin: 'prs', surface: 'terminal', component: 'Pane', requestId: 'prs', props: PANE_PROPS });
}

test('repos added with /add-dir show their PRs under bold repo headers with a divider between', async ($: any, on: any) => {
  register(on, {});
  installMocks(on, { repos: TWO_REPOS, transcript: [ADD_DIR_WEB] });

  const result = await $.command.run({ command: 'prs', args: '' });
  expect(result.text).toBeUndefined();

  const ui = await mountPane($);
  const api = await ui.find({ type: 'Text', text: 'app-deployments/api-backend' });
  const web = await ui.find({ type: 'Text', text: 'app-deployments/web-frontend' });
  expect(api?.props.bold).toBe(true);
  expect(web?.props.bold).toBe(true);

  const row = await ui.find({ key: 'open:/web:318' });
  expect(row?.text).toContain('trial campaign admin UI');
  expect(row?.props.plain).toBe(true);
  expect(await ui.find({ key: 'open:/api:77' })).toBeDefined();
  expect(await ui.find({ text: /^─{10,}$/ })).toBeDefined();
});

test('each repo collapses on its own, and expand all / collapse all act on every repo', async ($: any, on: any) => {
  register(on, {});
  installMocks(on, { repos: TWO_REPOS, transcript: [ADD_DIR_WEB] });
  await $.command.run({ command: 'prs', args: '--all' });
  const ui = await mountPane($);

  await ui.press({ key: 'toggle:/web' });
  expect(await ui.find({ key: 'open:/web:318' })).toBeUndefined();
  expect(await ui.find({ key: 'open:/api:77' })).toBeDefined();

  await ui.press({ key: 'collapse-all' });
  expect(await ui.find({ key: 'open:/api:77' })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: 'app-deployments/api-backend' })).toBeDefined();

  await ui.press({ key: 'expand-all' });
  expect(await ui.find({ key: 'open:/web:318' })).toBeDefined();
  expect(await ui.find({ key: 'open:/api:77' })).toBeDefined();
});

test('the PR list paints a gradient background to the pane bottom, with short centred dividers between PRs', async ($: any, on: any) => {
  register(on, {});
  installMocks(on, { repos: TWO_REPOS, transcript: [ADD_DIR_WEB] });
  await $.command.run({ command: 'prs', args: '--all' });
  const ui = await mountPane($);

  const rows = await ui.findAll({ type: 'Box' });
  const painted = rows.filter((b: any) => typeof b.props.backgroundColor === 'string');
  expect(painted.length).toBeGreaterThanOrEqual(PANE_PROPS.scroll.bodyRows);
  expect(new Set(painted.map((b: any) => b.props.backgroundColor)).size).toBeGreaterThan(5);

  const between = await ui.findAll({ type: 'Text', text: /^\s*┄+\s*$/ });
  expect(between.length).toBe(1); // web-frontend's two PRs; none after a repo's last PR
  expect(between[0]!.text.trim().length).toBeLessThan(PANE_PROPS.bodyColumns / 2);
});

test('opening a PR shows its files and commits without checking out, creating branches or worktrees', async ($: any, on: any) => {
  register(on, {});
  const gitCalls: string[][] = [];
  installMocks(on, { gitCalls });

  await $.command.run({ command: 'prs', args: '318' });
  const ui = await mountPane($);
  expect(await ui.find({ text: /app\.ts/ })).toBeDefined();
  await ui.press({ key: 'tab:commits' });
  expect(await ui.find({ text: /fix upload retry/ })).toBeDefined();

  const writes = gitCalls.filter(([sub, ...rest]) =>
    sub === 'checkout' || sub === 'switch' || sub === 'worktree' || sub === 'reset' || sub === 'stash' ||
    (sub === 'branch' && !rest.includes('--show-current')),
  );
  expect(writes).toEqual([]);
  expect(await ui.find({ text: /check(ed)? out/ })).toBeUndefined();
});
