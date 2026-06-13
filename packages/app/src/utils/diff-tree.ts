export interface DiffTreeInputFile {
  path: string;
  additions: number;
  deletions: number;
}

export type DiffTreeRow =
  | {
      kind: "directory";
      path: string;
      name: string;
      depth: number;
      additions: number;
      deletions: number;
    }
  | {
      kind: "file";
      path: string;
      name: string;
      depth: number;
      file: DiffTreeInputFile;
    };

interface DiffTreeNode {
  name: string;
  path: string;
  directories: Map<string, DiffTreeNode>;
  files: DiffTreeInputFile[];
  additions: number;
  deletions: number;
}

function createNode(name: string, path: string): DiffTreeNode {
  return {
    name,
    path,
    directories: new Map(),
    files: [],
    additions: 0,
    deletions: 0,
  };
}

function insertFile(root: DiffTreeNode, file: DiffTreeInputFile): void {
  const segments = file.path.split("/");
  const directorySegments = segments.slice(0, -1);

  let current = root;
  current.additions += file.additions;
  current.deletions += file.deletions;

  let accumulatedPath = "";
  for (const segment of directorySegments) {
    accumulatedPath = accumulatedPath ? `${accumulatedPath}/${segment}` : segment;
    let child = current.directories.get(segment);
    if (!child) {
      child = createNode(segment, accumulatedPath);
      current.directories.set(segment, child);
    }
    child.additions += file.additions;
    child.deletions += file.deletions;
    current = child;
  }

  current.files.push(file);
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}

function emitNode(
  node: DiffTreeNode,
  depth: number,
  expandedPaths: Set<string>,
  rows: DiffTreeRow[],
): void {
  const directories = [...node.directories.values()].sort(byName);
  for (const directory of directories) {
    rows.push({
      kind: "directory",
      path: directory.path,
      name: directory.name,
      depth,
      additions: directory.additions,
      deletions: directory.deletions,
    });
    if (expandedPaths.has(directory.path)) {
      emitNode(directory, depth + 1, expandedPaths, rows);
    }
  }

  const sortedFiles = [...node.files].sort((a, b) => {
    const aName = a.path.split("/").pop() ?? a.path;
    const bName = b.path.split("/").pop() ?? b.path;
    return aName.localeCompare(bName);
  });
  for (const file of sortedFiles) {
    rows.push({
      kind: "file",
      path: file.path,
      name: file.path.split("/").pop() ?? file.path,
      depth,
      file,
    });
  }
}

export function buildDiffTree({
  files,
  expandedPaths,
}: {
  files: DiffTreeInputFile[];
  expandedPaths: Set<string>;
}): DiffTreeRow[] {
  const root = createNode("", "");
  for (const file of files) {
    insertFile(root, file);
  }

  const rows: DiffTreeRow[] = [];
  emitNode(root, 0, expandedPaths, rows);
  return rows;
}
