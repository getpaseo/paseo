import { describe, expect, it } from "vitest";
import {
  copyFolder,
  type CopyFolderProgress,
  type LocalFileContents,
  type LocalFolder,
  type RemoteFolderEntry,
} from "./copy-folder";

class MemoryFolder implements LocalFolder {
  readonly files = new Map<string, Uint8Array>();
  readonly folders = new Map<string, MemoryFolder>();

  async folder(name: string): Promise<MemoryFolder> {
    const existing = this.folders.get(name);
    if (existing) return existing;
    const created = new MemoryFolder();
    this.folders.set(name, created);
    return created;
  }

  async writeFile(name: string, contents: LocalFileContents): Promise<void> {
    const bytes =
      contents instanceof Uint8Array
        ? contents
        : new Uint8Array(await new Response(contents).arrayBuffer());
    this.files.set(name, bytes);
  }

  /** Every path below this folder: folders end with `/`, files map to their text. */
  snapshot(prefix = ""): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, folder] of this.folders) {
      result[`${prefix}${name}/`] = "";
      Object.assign(result, folder.snapshot(`${prefix}${name}/`));
    }
    for (const [name, bytes] of this.files) {
      result[`${prefix}${name}`] = new TextDecoder().decode(bytes);
    }
    return result;
  }
}

/** A workspace tree keyed by path; directories list their children. */
function remoteTree(files: Record<string, string>, emptyDirectories: string[] = []) {
  const listings = new Map<string, RemoteFolderEntry[]>();
  const contents = new Map<string, Uint8Array>();
  const ensureDirectory = (path: string) => {
    if (listings.has(path)) return;
    listings.set(path, []);
    const slash = path.lastIndexOf("/");
    if (slash < 0) return;
    const parent = path.slice(0, slash);
    ensureDirectory(parent);
    listings.get(parent)!.push({ name: path.slice(slash + 1), path, kind: "directory", size: 0 });
  };
  for (const directory of emptyDirectories) ensureDirectory(directory);
  for (const [path, text] of Object.entries(files)) {
    const slash = path.lastIndexOf("/");
    const parent = path.slice(0, slash);
    ensureDirectory(parent);
    const bytes = new TextEncoder().encode(text);
    contents.set(path, bytes);
    listings
      .get(parent)!
      .push({ name: path.slice(slash + 1), path, kind: "file", size: bytes.byteLength });
  }
  const read: string[] = [];
  return {
    read,
    listDirectory: async (path: string) => {
      const entries = listings.get(path);
      if (!entries) throw new Error(`Requested path is not a directory: ${path}`);
      return entries;
    },
    readFile: async (file: RemoteFolderEntry): Promise<LocalFileContents> => {
      read.push(file.path);
      const bytes = contents.get(file.path);
      if (!bytes) throw new Error("File not found");
      return bytes;
    },
  };
}

function copy(
  tree: ReturnType<typeof remoteTree>,
  overrides: Partial<Parameters<typeof copyFolder>[0]> = {},
) {
  const destination = new MemoryFolder();
  const progress: CopyFolderProgress[] = [];
  const result = copyFolder({
    path: "reports",
    destination,
    includeHidden: true,
    listDirectory: tree.listDirectory,
    readFile: tree.readFile,
    signal: new AbortController().signal,
    onProgress: (step) => progress.push(step),
    ...overrides,
  });
  return { destination, progress, result };
}

describe("copyFolder", () => {
  it("recreates the tree, empty folders included, and reports progress up to the total", async () => {
    const tree = remoteTree(
      {
        "reports/summary.md": "# Summary",
        "reports/plots/a.svg": "<svg a/>",
        "reports/plots/deep/b.svg": "<svg b/>",
      },
      ["reports/empty"],
    );
    const { destination, progress, result } = copy(tree);

    expect(await result).toEqual({ total: 3, failures: [] });
    expect(destination.snapshot()).toEqual({
      "empty/": "",
      "plots/": "",
      "plots/deep/": "",
      "plots/a.svg": "<svg a/>",
      "plots/deep/b.svg": "<svg b/>",
      "summary.md": "# Summary",
    });
    expect(progress[0]).toEqual({ completed: 0, total: 3 });
    expect(progress.at(-1)).toEqual({ completed: 3, total: 3 });
  });

  it("writes streamed contents", async () => {
    const tree = remoteTree({ "reports/large.bin": "streamed bytes" });
    const { destination, result } = copy(tree, {
      readFile: async () => new Response("streamed bytes").body!,
    });

    await result;
    expect(destination.snapshot()).toEqual({ "large.bin": "streamed bytes" });
  });

  it("leaves out dotfiles and dot-folders when the tree hides them", async () => {
    const tree = remoteTree({
      "reports/.env": "SECRET=1",
      "reports/.cache/data": "cached",
      "reports/visible.txt": "shown",
    });
    const { destination, result } = copy(tree, { includeHidden: false });

    expect(await result).toEqual({ total: 1, failures: [] });
    expect(destination.snapshot()).toEqual({ "visible.txt": "shown" });
    expect(tree.read).toEqual(["reports/visible.txt"]);
  });

  it("records files and folders that fail and copies the rest", async () => {
    const tree = remoteTree({
      "reports/ok.txt": "fine",
      "reports/broken.txt": "unreadable",
      "reports/nested/also-ok.txt": "fine too",
    });
    const { destination, result } = copy(tree, {
      listDirectory: async (path) => {
        const entries = await tree.listDirectory(path);
        return path === "reports"
          ? [...entries, { name: "link", path: "reports/link", kind: "directory", size: 0 }]
          : entries;
      },
      readFile: async (file) => {
        if (file.name === "broken.txt") throw new Error("Permission denied");
        return tree.readFile(file);
      },
    });

    expect(await result).toEqual({
      total: 3,
      failures: [
        { path: "reports/link", error: "Requested path is not a directory: reports/link" },
        { path: "reports/broken.txt", error: "Permission denied" },
      ],
    });
    expect(destination.snapshot()).toEqual({
      "link/": "",
      "nested/": "",
      "nested/also-ok.txt": "fine too",
      "ok.txt": "fine",
    });
  });

  it("stops reading files once cancelled", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 20; index++) files[`reports/file-${index}.txt`] = `${index}`;
    const tree = remoteTree(files);
    const controller = new AbortController();
    const { result } = copy(tree, {
      signal: controller.signal,
      concurrency: 1,
      readFile: async (file) => {
        if (tree.read.length === 2) controller.abort(new Error("cancelled"));
        return tree.readFile(file);
      },
    });

    await expect(result).rejects.toThrow("cancelled");
    expect(tree.read).toHaveLength(3);
  });
});
