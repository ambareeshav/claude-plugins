// Pure tree-shaping only — no `$` calls here. See note in lib/git.ts.

export type FileChange = { path: string; status: string; added: number | null; deleted: number | null };

type DirNode = { kind: 'dir'; children: Map<string, DirNode | FileNode> };
type FileNode = { kind: 'file'; file: FileChange };

export type TreeRow =
  | { kind: 'dir'; depth: number; name: string }
  | { kind: 'file'; depth: number; name: string; file: FileChange };

function insert(root: DirNode, file: FileChange): void {
  const parts = file.path.split('/');
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i];
    const existing = node.children.get(seg);
    if (existing && existing.kind === 'dir') {
      node = existing;
    } else {
      const dir: DirNode = { kind: 'dir', children: new Map() };
      node.children.set(seg, dir);
      node = dir;
    }
  }
  node.children.set(parts[parts.length - 1], { kind: 'file', file });
}

/** Builds a directory tree of the changed files and flattens it to rows in
 * display order (directories first, alphabetical), compressing a chain of
 * single-child directories into one row (`src/components/admin` on one line). */
export function buildFileTreeRows(files: FileChange[]): TreeRow[] {
  const root: DirNode = { kind: 'dir', children: new Map() };
  for (const f of files) insert(root, f);

  const rows: TreeRow[] = [];
  const walk = (node: DirNode, depth: number) => {
    const entries = [...node.children.entries()].sort(([aName, a], [bName, b]) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return aName.localeCompare(bName);
    });
    for (const [name, child] of entries) {
      if (child.kind === 'file') {
        rows.push({ kind: 'file', depth, name, file: child.file });
        continue;
      }
      let label = name;
      let cur = child;
      while (cur.children.size === 1) {
        const [[onlyName, only]] = cur.children.entries();
        if (only.kind !== 'dir') break;
        label += '/' + onlyName;
        cur = only;
      }
      rows.push({ kind: 'dir', depth, name: label });
      walk(cur, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}
