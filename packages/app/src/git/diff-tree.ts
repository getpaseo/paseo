import type { ParsedDiffFile } from "@/git/use-diff-query";

// Builds a directory hierarchy from the flat, path-sorted `ParsedDiffFile[]` the
// Changes view renders. The tree renders on every form factor, consistent with
// the Files explorer.
//
// Directory nodes are keyed by their FULL uncompressed path (e.g. "packages/app/src").
// That path is the stable identity used to persist folder-collapse state, so the
// state survives path-compression changes as the diff mutates: if a compressed
// row later splits because a sibling appears, the logical directories keep the
// same keys.

export interface DiffTreeFileNode {
  kind: "file";
  file: ParsedDiffFile;
  /** basename, e.g. "diff-pane.tsx" */
  name: string;
}

export interface DiffTreeDirNode {
  kind: "dir";
  /** full uncompressed directory path, e.g. "packages/app/src"; "" for the virtual root */
  dirPath: string;
  /** display label; a compressed chain joins segments, e.g. "packages/app/src" */
  name: string;
  children: DiffTreeNode[];
}

export type DiffTreeNode = DiffTreeFileNode | DiffTreeDirNode;

export interface DiffTreeFolderRow {
  kind: "folder";
  /** full uncompressed path of the DEEPEST directory this row represents */
  dirPath: string;
  /** compressed display label, e.g. "packages/app/src" */
  displayName: string;
  depth: number;
  additions: number;
  deletions: number;
}

export interface DiffTreeFileRow {
  kind: "file";
  file: ParsedDiffFile;
  depth: number;
}

export type DiffTreeRow = DiffTreeFolderRow | DiffTreeFileRow;

function sortTree(node: DiffTreeDirNode): void {
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) {
      // directories before files within a level
      return a.kind === "dir" ? -1 : 1;
    }
    // Plain ASCII comparison, matching compareCheckoutDiffPaths (diff-order.ts)
    // so the tree order is consistent with the rest of the Changes view.
    if (a.name === b.name) return 0;
    return a.name < b.name ? -1 : 1;
  });
  for (const child of node.children) {
    if (child.kind === "dir") {
      sortTree(child);
    }
  }
}

/** Build the (uncompressed) directory tree. Returns the virtual root (dirPath ""). */
export function buildDiffTree(files: ParsedDiffFile[]): DiffTreeDirNode {
  const root: DiffTreeDirNode = { kind: "dir", dirPath: "", name: "", children: [] };
  const dirByPath = new Map<string, DiffTreeDirNode>([["", root]]);

  function ensureDir(dirPath: string): DiffTreeDirNode {
    const existing = dirByPath.get(dirPath);
    if (existing) {
      return existing;
    }
    const parts = dirPath.split("/");
    const name = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join("/");
    const parent = ensureDir(parentPath);
    const node: DiffTreeDirNode = { kind: "dir", dirPath, name, children: [] };
    parent.children.push(node);
    dirByPath.set(dirPath, node);
    return node;
  }

  for (const file of files) {
    const parts = file.path.split("/");
    const name = parts[parts.length - 1];
    const dirPath = parts.slice(0, -1).join("/");
    ensureDir(dirPath).children.push({ kind: "file", file, name });
  }

  sortTree(root);
  return root;
}

// Collapse runs of single-child directories into one row, like VS Code / GitHub:
// a directory whose only child is another directory absorbs it. The merged row
// displays the joined segments ("packages/app/src") but keeps the DEEPEST
// directory's full path as its identity.
function compressNode(node: DiffTreeDirNode): DiffTreeDirNode {
  let name = node.name;
  let dirPath = node.dirPath;
  let children = node.children.map((child) => (child.kind === "dir" ? compressNode(child) : child));
  while (children.length === 1 && children[0].kind === "dir") {
    const only = children[0];
    name = name ? `${name}/${only.name}` : only.name;
    dirPath = only.dirPath;
    children = only.children;
  }
  return { kind: "dir", dirPath, name, children };
}

/**
 * Compress single-child directory chains. The virtual root is never merged
 * (it isn't rendered); only its subtrees are compressed.
 */
export function compressSingleChildChains(root: DiffTreeDirNode): DiffTreeDirNode {
  return {
    ...root,
    children: root.children.map((child) => (child.kind === "dir" ? compressNode(child) : child)),
  };
}

interface DirStats {
  additions: number;
  deletions: number;
}

const EMPTY_DIR_STATS: DirStats = { additions: 0, deletions: 0 };

// Single post-order pass computing every directory node's aggregate stats from
// its already-summed children — O(n), vs. re-walking each subtree per folder row.
function computeDirStats(root: DiffTreeDirNode): Map<DiffTreeDirNode, DirStats> {
  const statsByNode = new Map<DiffTreeDirNode, DirStats>();
  function visit(node: DiffTreeDirNode): DirStats {
    const stats: DirStats = { additions: 0, deletions: 0 };
    for (const child of node.children) {
      if (child.kind === "file") {
        stats.additions += child.file.additions;
        stats.deletions += child.file.deletions;
      } else {
        const childStats = visit(child);
        stats.additions += childStats.additions;
        stats.deletions += childStats.deletions;
      }
    }
    statsByNode.set(node, stats);
    return stats;
  }
  visit(root);
  return statsByNode;
}

/**
 * Flatten the (compressed) tree into depth-tagged rows for the list. Descendants
 * of any directory whose `dirPath` is in `collapsed` are omitted; folder rows
 * always carry the FULL aggregate stats of their subtree, collapsed or not.
 */
export function flattenDiffTree(
  root: DiffTreeDirNode,
  collapsed: ReadonlySet<string>,
): DiffTreeRow[] {
  const statsByNode = computeDirStats(root);
  const rows: DiffTreeRow[] = [];

  function walk(node: DiffTreeDirNode, depth: number): void {
    for (const child of node.children) {
      if (child.kind === "file") {
        rows.push({ kind: "file", file: child.file, depth });
        continue;
      }
      const stats = statsByNode.get(child) ?? EMPTY_DIR_STATS;
      rows.push({
        kind: "folder",
        dirPath: child.dirPath,
        displayName: child.name,
        depth,
        additions: stats.additions,
        deletions: stats.deletions,
      });
      if (!collapsed.has(child.dirPath)) {
        walk(child, depth + 1);
      }
    }
  }

  walk(root, 0);
  return rows;
}

/** Every directory path in the (compressed) tree — used for "collapse all folders". */
export function collectDirPaths(root: DiffTreeDirNode): string[] {
  const paths: string[] = [];
  function walk(node: DiffTreeDirNode): void {
    for (const child of node.children) {
      if (child.kind === "dir") {
        paths.push(child.dirPath);
        walk(child);
      }
    }
  }
  walk(root);
  return paths;
}
