import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findTypedFilePath, locateTypedPath, type ListDirectory } from "./typed-file-path";

describe("locateTypedPath", () => {
  it("splits absolute and home-relative paths into parent and name", () => {
    expect(locateTypedPath("/a.txt")).toEqual({ parent: "/", name: "a.txt" });
    expect(locateTypedPath(" /tmp/x/a.txt ")).toEqual({ parent: "/tmp/x", name: "a.txt" });
    expect(locateTypedPath("//tmp//x/a.txt")).toEqual({ parent: "/tmp/x", name: "a.txt" });
    expect(locateTypedPath("~/x/y.md")).toEqual({ parent: "~/x", name: "y.md" });
    expect(locateTypedPath("~/y.md")).toEqual({ parent: "~", name: "y.md" });
  });

  it("ignores queries that cannot name a file", () => {
    expect(locateTypedPath("")).toBeNull();
    expect(locateTypedPath("repo")).toBeNull();
    expect(locateTypedPath("src/a.txt")).toBeNull();
    expect(locateTypedPath("/")).toBeNull();
    expect(locateTypedPath("~")).toBeNull();
    expect(locateTypedPath("~/")).toBeNull();
    expect(locateTypedPath("/tmp/x/")).toBeNull();
    expect(locateTypedPath("/tmp/..")).toBeNull();
  });
});

describe("findTypedFilePath", () => {
  let home: string;
  let listDirectory: ListDirectory;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "paseo-typed-file-path-"));
    await mkdir(path.join(home, "x", "nested"), { recursive: true });
    await writeFile(path.join(home, "x", "y.md"), "notes");
    await writeFile(path.join(home, "a.txt"), "top");
    await symlink(path.join(home, "x", "nested"), path.join(home, "x", "linked-dir"));
    // Lists the way the daemon's file explorer does: entry kinds come from readdir, so a symlink
    // is a "file" whatever it points to, and listing anything but a directory fails.
    listDirectory = async (cwd, relativePath) => {
      const root = cwd === "~" || cwd.startsWith("~/") ? path.join(home, cwd.slice(1)) : cwd;
      const target = path.join(root, relativePath);
      if (!(await stat(target)).isDirectory()) throw new Error("Requested path is not a directory");
      const dirents = await readdir(target, { withFileTypes: true });
      return {
        entries: dirents.map((dirent) => ({
          name: dirent.name,
          kind: dirent.isDirectory() ? "directory" : "file",
        })),
      };
    };
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("finds an absolute file path and returns its directory", async () => {
    const query = path.join(home, "x", "y.md");
    await expect(findTypedFilePath({ query, listDirectory })).resolves.toEqual({
      parent: path.join(home, "x"),
      name: "y.md",
    });
  });

  it("finds a home-relative file path", async () => {
    await expect(findTypedFilePath({ query: "~/x/y.md", listDirectory })).resolves.toEqual({
      parent: "~/x",
      name: "y.md",
    });
    await expect(findTypedFilePath({ query: "~/a.txt", listDirectory })).resolves.toEqual({
      parent: "~",
      name: "a.txt",
    });
  });

  it("leaves a directory path alone, including one behind a symlink", async () => {
    await expect(
      findTypedFilePath({ query: path.join(home, "x", "nested"), listDirectory }),
    ).resolves.toBeNull();
    await expect(
      findTypedFilePath({ query: path.join(home, "x", "linked-dir"), listDirectory }),
    ).resolves.toBeNull();
  });

  it("offers nothing for a path that does not exist", async () => {
    await expect(
      findTypedFilePath({ query: path.join(home, "x", "y.m"), listDirectory }),
    ).resolves.toBeNull();
    await expect(
      findTypedFilePath({ query: path.join(home, "missing", "y.md"), listDirectory }),
    ).resolves.toBeNull();
  });
});
