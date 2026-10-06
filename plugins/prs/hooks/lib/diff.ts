// Pure text-shaping only — no `$` calls here. See note in lib/git.ts.

/** Drops git's `diff --git`/`index`/`---`/`+++` boilerplate, keeping only the
 * `@@` hunks — the part someone reviewing actually reads. */
export function cleanUnifiedDiff(raw: string): string {
  const lines = raw.split('\n');
  const start = lines.findIndex((l) => l.startsWith('@@'));
  if (start === -1) return '(no line-level changes — rename, mode change, or binary file)';
  return lines.slice(start).join('\n');
}
