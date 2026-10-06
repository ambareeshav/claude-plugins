// Pure shaping only — no `$` calls here. See note in lib/git.ts.

import type { AdoRepoContext } from './git';

export const ADO_API_VERSION = '7.1';
export const ADO_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798';

export type PullRequestSummary = {
  pullRequestId: number;
  title: string;
  status: string;
  createdBy: string;
  sourceRefName: string;
  targetRefName: string;
  creationDate: string;
  isDraft: boolean;
};

export type PullRequestDetail = PullRequestSummary & {
  description: string;
};

// ADO answers a request it won't authorize with a 203 HTML sign-in page, not a
// 401. That page (and the x-vss-resourcetenant header, when the redirect isn't
// followed) names the Entra tenant backing the org.
export function isSignInPage(res: { status: number; headers: Record<string, string>; text: string }): boolean {
  const type = res.headers['content-type'] ?? '';
  return res.status === 203 || type.includes('text/html') || (res.text ?? '').trimStart().startsWith('<');
}

const TENANT_IN_SIGN_IN = /login\.microsoftonline\.com\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i;

export function tenantFromSignIn(res: { headers: Record<string, string>; text: string }): string | undefined {
  return res.headers['x-vss-resourcetenant'] || TENANT_IN_SIGN_IN.exec(res.text ?? '')?.[1];
}

export function adoBaseUrl(ctx: AdoRepoContext): string {
  return `https://dev.azure.com/${encodeURIComponent(ctx.org)}/${encodeURIComponent(ctx.project)}/_apis/git/repositories/${encodeURIComponent(ctx.repo)}`;
}

export function toPullRequestSummary(pr: any): PullRequestSummary {
  return {
    pullRequestId: pr.pullRequestId,
    title: pr.title,
    status: pr.status,
    createdBy: pr.createdBy?.displayName ?? 'unknown',
    sourceRefName: pr.sourceRefName,
    targetRefName: pr.targetRefName,
    creationDate: pr.creationDate,
    isDraft: !!pr.isDraft,
  };
}
