// Pure parsing only — nothing here touches `$`. Anything that runs `git`
// itself lives in register.tsx (the validator requires every `$` call to
// be textually in the hooks module file, not reached through an import).

export type AdoRepoContext = {
  org: string;
  project: string;
  repo: string;
};

export type GithubRepoContext = {
  owner: string;
  repo: string;
};

export type RepoContext =
  | { provider: 'ado'; ado: AdoRepoContext }
  | { provider: 'github'; github: GithubRepoContext };

const DEV_AZURE_RE =
  /^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/i;
const SSH_RE = /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/i;
const VS_RE = /^https:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/i;

const GITHUB_HTTPS_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;
const GITHUB_SSH_RE = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i;

export function parseAdoRemote(url: string): AdoRepoContext | null {
  const trimmed = url.trim();

  let m = trimmed.match(DEV_AZURE_RE);
  if (m) return { org: decodeURIComponent(m[1]), project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]) };

  m = trimmed.match(SSH_RE);
  if (m) return { org: m[1], project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]) };

  m = trimmed.match(VS_RE);
  if (m) return { org: m[1], project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]) };

  return null;
}

export function parseGithubRemote(url: string): GithubRepoContext | null {
  const trimmed = url.trim();

  let m = trimmed.match(GITHUB_HTTPS_RE);
  if (m) return { owner: m[1], repo: m[2] };

  m = trimmed.match(GITHUB_SSH_RE);
  if (m) return { owner: m[1], repo: m[2] };

  return null;
}

export function parseRemote(url: string): RepoContext | null {
  const github = parseGithubRemote(url);
  if (github) return { provider: 'github', github };

  const ado = parseAdoRemote(url);
  if (ado) return { provider: 'ado', ado };

  return null;
}

export function branchName(ref: string): string {
  return ref.replace('refs/heads/', '');
}

export function prWebUrl(ctx: RepoContext, id: number): string {
  return ctx.provider === 'github'
    ? `https://github.com/${ctx.github.owner}/${ctx.github.repo}/pull/${id}`
    : `https://dev.azure.com/${encodeURIComponent(ctx.ado.org)}/${encodeURIComponent(ctx.ado.project)}/_git/${encodeURIComponent(ctx.ado.repo)}/pullrequest/${id}`;
}
