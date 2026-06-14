export interface DiffFileTreeInputFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface DiffFileTreeDirectoryNode<TFile extends DiffFileTreeInputFile> {
  type: "directory";
  key: string;
  name: string;
  path: string;
  depth: number;
  additions: number;
  deletions: number;
  children: DiffFileTreeNode<TFile>[];
}

export interface DiffFileTreeFileNode<TFile extends DiffFileTreeInputFile> {
  type: "file";
  key: string;
  name: string;
  path: string;
  depth: number;
  additions: number;
  deletions: number;
  file: TFile;
}

export type DiffFileTreeNode<TFile extends DiffFileTreeInputFile> =
  | DiffFileTreeDirectoryNode<TFile>
  | DiffFileTreeFileNode<TFile>;

export type FlattenedDiffFileTreeItem<TFile extends DiffFileTreeInputFile> =
  | { type: "directory"; node: DiffFileTreeDirectoryNode<TFile> }
  | { type: "file"; node: DiffFileTreeFileNode<TFile> };

function splitFilePath(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function addStats<TFile extends DiffFileTreeInputFile>(
  node: DiffFileTreeDirectoryNode<TFile>,
  file: TFile,
): void {
  node.additions += file.additions;
  node.deletions += file.deletions;
}

function findDirectory<TFile extends DiffFileTreeInputFile>(
  children: DiffFileTreeNode<TFile>[],
  path: string,
): DiffFileTreeDirectoryNode<TFile> | null {
  const node = children.find((child) => child.type === "directory" && child.path === path);
  return node?.type === "directory" ? node : null;
}

export function buildDiffFileTree<TFile extends DiffFileTreeInputFile>(
  files: readonly TFile[],
): DiffFileTreeNode<TFile>[] {
  const roots: DiffFileTreeNode<TFile>[] = [];

  for (const file of files) {
    const segments = splitFilePath(file.path);
    const fileName = segments.at(-1) ?? file.path;
    let siblings = roots;

    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      if (!segment) {
        continue;
      }
      const directoryPath = segments.slice(0, index + 1).join("/");
      let directory = findDirectory(siblings, directoryPath);
      if (!directory) {
        directory = {
          type: "directory",
          key: `directory:${directoryPath}`,
          name: segment,
          path: directoryPath,
          depth: index,
          additions: 0,
          deletions: 0,
          children: [],
        };
        siblings.push(directory);
      }
      addStats(directory, file);
      siblings = directory.children;
    }

    siblings.push({
      type: "file",
      key: `file:${file.path}`,
      name: fileName,
      path: file.path,
      depth: Math.max(0, segments.length - 1),
      additions: file.additions,
      deletions: file.deletions,
      file,
    });
  }

  return roots;
}

export function flattenDiffFileTree<TFile extends DiffFileTreeInputFile>(input: {
  nodes: readonly DiffFileTreeNode<TFile>[];
  collapsedDirectoryPaths: ReadonlySet<string>;
}): FlattenedDiffFileTreeItem<TFile>[] {
  const result: FlattenedDiffFileTreeItem<TFile>[] = [];

  function visit(nodes: readonly DiffFileTreeNode<TFile>[]): void {
    for (const node of nodes) {
      if (node.type === "file") {
        result.push({ type: "file", node });
        continue;
      }

      result.push({ type: "directory", node });
      if (!input.collapsedDirectoryPaths.has(node.path)) {
        visit(node.children);
      }
    }
  }

  visit(input.nodes);
  return result;
}
