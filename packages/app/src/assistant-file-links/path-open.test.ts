import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveInlinePathOpen } from "./path-open";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("distinguishes dotted and extensionless folders from files using the filesystem", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "folder-link-"));
  roots.push(workspaceRoot);
  await mkdir(path.join(workspaceRoot, "docs/guides"), { recursive: true });
  await mkdir(path.join(workspaceRoot, "docs/reports.v1"));
  await writeFile(path.join(workspaceRoot, "Makefile"), "all:\n");
  await writeFile(path.join(workspaceRoot, "README.md"), "# Readme\n");
  const client = {
    listDirectory: (root: string, file: string) => readdir(path.resolve(root, file)),
  };
  for (const file of ["docs/guides", "docs/reports.v1"]) {
    await expect(
      resolveInlinePathOpen({ file, directory: "docs", workspaceRoot, client }),
    ).resolves.toEqual({ kind: "directory", directoryPath: file });
  }
  for (const file of ["Makefile", "README.md", "missing.md"]) {
    await expect(
      resolveInlinePathOpen({ file, directory: ".", workspaceRoot, client }),
    ).resolves.toEqual({ kind: "file" });
  }
});

it("preserves explicit directory destinations and file line references", async () => {
  const workspaceRoot = "/repo";
  await expect(
    resolveInlinePathOpen({ directory: "docs/guides", workspaceRoot, client: null }),
  ).resolves.toEqual({ kind: "directory", directoryPath: "docs/guides" });
  await expect(
    resolveInlinePathOpen({
      file: "docs/guides",
      directory: "docs",
      lineStart: 12,
      workspaceRoot,
      client: null,
    }),
  ).resolves.toEqual({ kind: "file" });
});

it("keeps unavailable probes and external paths on the existing file-open path", async () => {
  for (const file of ["Makefile", "/external/folder", "C:/external/folder"]) {
    await expect(
      resolveInlinePathOpen({ file, directory: ".", workspaceRoot: "/repo", client: null }),
    ).resolves.toEqual({ kind: "file" });
  }
});

it("ignores an older probe after a newer file link opens", async () => {
  const { createInlinePathOpener } = await import("./path-open");
  let rejectProbe!: (error: Error) => void;
  const pendingProbe = new Promise<never>((_, reject) => {
    rejectProbe = reject;
  });
  const opened: string[] = [];
  const opener = createInlinePathOpener({
    workspaceRoot: "/repo",
    client: { listDirectory: () => pendingProbe },
    openFile: (location) => {
      opened.push(location.path);
    },
    openDirectory: (directory) => {
      opened.push(directory);
    },
  });
  const first = opener.open({ raw: "./first.md", path: "/repo/first.md" }, "preferred");
  await opener.open({ raw: "./second.md:2", path: "/repo/second.md", lineStart: 2 }, "preferred");
  rejectProbe(new Error("Not a directory"));
  await first;
  expect(opened).toEqual(["second.md"]);
});

it("ignores a pending probe when its view is left", async () => {
  const { createInlinePathOpener } = await import("./path-open");
  let resolveProbe!: (value: unknown) => void;
  const pendingProbe = new Promise((resolve) => {
    resolveProbe = resolve;
  });
  const opened: string[] = [];
  const opener = createInlinePathOpener({
    workspaceRoot: "/repo",
    client: { listDirectory: () => pendingProbe },
    openFile: (location) => {
      opened.push(location.path);
    },
    openDirectory: (directory) => {
      opened.push(directory);
    },
  });
  const pending = opener.open({ raw: "./docs", path: "/repo/docs" }, "preferred");
  opener.cancel();
  resolveProbe({});
  await pending;
  expect(opened).toEqual([]);
});
