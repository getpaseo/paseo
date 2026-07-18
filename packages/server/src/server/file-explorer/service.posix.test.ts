// POSIX-only: symlink fixtures
/* eslint-disable max-nested-callbacks */
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deleteExplorerEntry,
  duplicateExplorerEntry,
  getDownloadableFileInfo,
  listDirectoryEntries,
  readExplorerFile,
  renameExplorerEntry,
} from "./service.js";
import { isPlatform } from "../../test-utils/platform.js";

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe.skipIf(isPlatform("win32"))("service POSIX-only", () => {
  it("lists directory entries even when a dangling symlink exists", async () => {
    const root = await createTempDir("paseo-file-explorer-");

    try {
      await mkdir(path.join(root, "packages", "server"), { recursive: true });
      const serverDir = path.join(root, "packages", "server");
      await writeFile(path.join(serverDir, "README.md"), "# server\n", "utf-8");
      await symlink("CLAUDE.md", path.join(serverDir, "AGENTS.md"));

      const result = await listDirectoryEntries({
        root,
        relativePath: "packages/server",
      });

      expect(result.path).toBe("packages/server");
      const names = result.entries.map((entry) => entry.name);
      expect(names).toContain("README.md");
      expect(names).not.toContain("AGENTS.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked files that resolve outside the workspace", async () => {
    const root = await createTempDir("paseo-file-explorer-");
    const outsideRoot = await createTempDir("paseo-file-explorer-outside-");

    try {
      const externalFile = path.join(outsideRoot, "secret.txt");
      await writeFile(externalFile, "top secret\n", "utf-8");
      await symlink(externalFile, path.join(root, "secret-link.txt"));

      await expect(
        readExplorerFile({
          root,
          relativePath: "secret-link.txt",
        }),
      ).rejects.toThrow("Access outside of workspace is not allowed");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("skips listed symlink entries that resolve outside the workspace", async () => {
    const root = await createTempDir("paseo-file-explorer-");
    const outsideRoot = await createTempDir("paseo-file-explorer-outside-");

    try {
      await writeFile(path.join(root, "visible.txt"), "visible\n", "utf-8");
      const externalFile = path.join(outsideRoot, "secret.txt");
      await writeFile(externalFile, "top secret\n", "utf-8");
      await symlink(externalFile, path.join(root, "secret-link.txt"));

      const result = await listDirectoryEntries({ root });

      const names = result.entries.map((entry) => entry.name);
      expect(names).toContain("visible.txt");
      expect(names).not.toContain("secret-link.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("uses canonical paths for downloadable symlink targets inside the workspace", async () => {
    const root = await createTempDir("paseo-file-explorer-");

    try {
      const target = path.join(root, "safe.txt");
      const link = path.join(root, "safe-link.txt");
      await writeFile(target, "safe\n", "utf-8");
      await symlink("safe.txt", link);

      const file = await readExplorerFile({
        root,
        relativePath: "safe-link.txt",
      });
      const info = await getDownloadableFileInfo({
        root,
        relativePath: "safe-link.txt",
      });

      expect(file.path).toBe("safe-link.txt");
      expect(file.content).toBe("safe\n");
      expect(info.path).toBe("safe-link.txt");
      expect(info.fileName).toBe("safe-link.txt");
      expect(info.absolutePath).toBe(await realpath(target));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deletes an in-workspace symlink without removing the referent", async () => {
    const root = await createTempDir("paseo-file-explorer-");

    try {
      const target = path.join(root, "nested", "target.txt");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "keep me\n", "utf-8");
      await symlink("nested/target.txt", path.join(root, "alias.txt"));

      await deleteExplorerEntry({ root, path: "alias.txt" });

      await expect(access(path.join(root, "alias.txt"))).rejects.toThrow();
      expect(await readFile(target, "utf-8")).toBe("keep me\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renames an in-workspace symlink without touching the referent", async () => {
    const root = await createTempDir("paseo-file-explorer-");

    try {
      await writeFile(path.join(root, "target.txt"), "data\n", "utf-8");
      await symlink("target.txt", path.join(root, "alias.txt"));

      const renamed = await renameExplorerEntry({
        root,
        path: "alias.txt",
        newName: "alias-renamed.txt",
      });

      expect(renamed.path).toBe("alias-renamed.txt");
      expect(await readlink(path.join(root, "alias-renamed.txt"))).toBe("target.txt");
      expect(await readFile(path.join(root, "target.txt"), "utf-8")).toBe("data\n");
      await expect(access(path.join(root, "alias.txt"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("duplicates an in-workspace symlink as another symlink", async () => {
    const root = await createTempDir("paseo-file-explorer-");

    try {
      await writeFile(path.join(root, "target.txt"), "data\n", "utf-8");
      await symlink("target.txt", path.join(root, "alias.txt"));

      const duplicated = await duplicateExplorerEntry({ root, path: "alias.txt" });

      expect(duplicated.path).toBe("alias copy.txt");
      expect(await readlink(path.join(root, "alias copy.txt"))).toBe("target.txt");
      expect(await readFile(path.join(root, "target.txt"), "utf-8")).toBe("data\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
