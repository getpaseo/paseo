import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createExplorerEntry,
  deleteExplorerEntry,
  duplicateExplorerEntry,
  renameExplorerEntry,
} from "./service.js";

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("file explorer mutations", () => {
  it("creates files and directories", async () => {
    const root = await createTempDir("paseo-file-explorer-mutate-");

    try {
      await mkdir(path.join(root, "src"), { recursive: true });

      const file = await createExplorerEntry({
        root,
        parentPath: "src",
        name: "notes.txt",
        kind: "file",
      });
      expect(file).toMatchObject({
        name: "notes.txt",
        path: "src/notes.txt",
        kind: "file",
        size: 0,
      });
      expect(await readFile(path.join(root, "src", "notes.txt"), "utf-8")).toBe("");

      const directory = await createExplorerEntry({
        root,
        parentPath: "src",
        name: "lib",
        kind: "directory",
      });
      expect(directory).toMatchObject({
        name: "lib",
        path: "src/lib",
        kind: "directory",
      });
      await access(path.join(root, "src", "lib"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renames entries within the same parent", async () => {
    const root = await createTempDir("paseo-file-explorer-mutate-");

    try {
      await writeFile(path.join(root, "alpha.txt"), "hello\n", "utf-8");

      const renamed = await renameExplorerEntry({
        root,
        path: "alpha.txt",
        newName: "beta.txt",
      });

      expect(renamed).toMatchObject({
        name: "beta.txt",
        path: "beta.txt",
        kind: "file",
      });
      expect(await readFile(path.join(root, "beta.txt"), "utf-8")).toBe("hello\n");
      await expect(access(path.join(root, "alpha.txt"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deletes files and directories recursively", async () => {
    const root = await createTempDir("paseo-file-explorer-mutate-");

    try {
      await writeFile(path.join(root, "gone.txt"), "x", "utf-8");
      await mkdir(path.join(root, "nested", "inner"), { recursive: true });
      await writeFile(path.join(root, "nested", "inner", "file.txt"), "y", "utf-8");

      await deleteExplorerEntry({ root, path: "gone.txt" });
      await deleteExplorerEntry({ root, path: "nested" });

      const names = await readdir(root);
      expect(names).not.toContain("gone.txt");
      expect(names).not.toContain("nested");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("duplicates files and directories with unique copy names", async () => {
    const root = await createTempDir("paseo-file-explorer-mutate-");

    try {
      await writeFile(path.join(root, "foo.txt"), "content\n", "utf-8");
      await mkdir(path.join(root, "folder", "child"), { recursive: true });
      await writeFile(path.join(root, "folder", "child", "a.txt"), "a\n", "utf-8");

      const firstFileCopy = await duplicateExplorerEntry({ root, path: "foo.txt" });
      expect(firstFileCopy).toMatchObject({
        name: "foo copy.txt",
        path: "foo copy.txt",
        kind: "file",
      });
      expect(await readFile(path.join(root, "foo copy.txt"), "utf-8")).toBe("content\n");

      const secondFileCopy = await duplicateExplorerEntry({ root, path: "foo.txt" });
      expect(secondFileCopy.name).toBe("foo copy 2.txt");

      const folderCopy = await duplicateExplorerEntry({ root, path: "folder" });
      expect(folderCopy).toMatchObject({
        name: "folder copy",
        path: "folder copy",
        kind: "directory",
      });
      expect(await readFile(path.join(root, "folder copy", "child", "a.txt"), "utf-8")).toBe("a\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects path traversal and invalid names", async () => {
    const root = await createTempDir("paseo-file-explorer-mutate-");

    try {
      await expect(
        createExplorerEntry({
          root,
          parentPath: ".",
          name: "../escape.txt",
          kind: "file",
        }),
      ).rejects.toThrow("Invalid entry name");

      await expect(
        createExplorerEntry({
          root,
          parentPath: ".",
          name: "nested/path.txt",
          kind: "file",
        }),
      ).rejects.toThrow("Invalid entry name");

      await expect(
        createExplorerEntry({
          root,
          parentPath: ".",
          name: "..",
          kind: "directory",
        }),
      ).rejects.toThrow("Invalid entry name");

      await writeFile(path.join(root, "alpha.txt"), "x", "utf-8");
      await expect(
        renameExplorerEntry({
          root,
          path: "alpha.txt",
          newName: "evil/name.txt",
        }),
      ).rejects.toThrow("Invalid entry name");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects access outside the workspace", async () => {
    const root = await createTempDir("paseo-file-explorer-mutate-");

    try {
      await expect(
        createExplorerEntry({
          root,
          parentPath: "..",
          name: "escape.txt",
          kind: "file",
        }),
      ).rejects.toThrow("Access outside of workspace is not allowed");

      await expect(
        deleteExplorerEntry({
          root,
          path: "../outside.txt",
        }),
      ).rejects.toThrow("Access outside of workspace is not allowed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects delete and rename of the workspace root", async () => {
    const root = await createTempDir("paseo-file-explorer-mutate-");

    try {
      await expect(deleteExplorerEntry({ root, path: "." })).rejects.toThrow(
        "Cannot delete the workspace root",
      );
      await expect(
        renameExplorerEntry({
          root,
          path: ".",
          newName: "elsewhere",
        }),
      ).rejects.toThrow("Cannot rename the workspace root");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects creating an entry that already exists", async () => {
    const root = await createTempDir("paseo-file-explorer-mutate-");

    try {
      await writeFile(path.join(root, "exists.txt"), "x", "utf-8");
      await expect(
        createExplorerEntry({
          root,
          parentPath: ".",
          name: "exists.txt",
          kind: "file",
        }),
      ).rejects.toThrow("An entry with that name already exists");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows case-only renames", async () => {
    const root = await createTempDir("paseo-file-explorer-mutate-");

    try {
      await writeFile(path.join(root, "alpha.txt"), "hello\n", "utf-8");

      const renamed = await renameExplorerEntry({
        root,
        path: "alpha.txt",
        newName: "Alpha.txt",
      });

      expect(renamed).toMatchObject({
        name: "Alpha.txt",
        path: "Alpha.txt",
        kind: "file",
      });
      expect(await readFile(path.join(root, "Alpha.txt"), "utf-8")).toBe("hello\n");
      const names = await readdir(root);
      expect(names).toContain("Alpha.txt");
      expect(names).not.toContain("alpha.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
