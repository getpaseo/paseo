import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getExplorerFileVersion, readExplorerFile, writeExplorerFile } from "./service.js";

async function createHomeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.homedir(), prefix));
}

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("file explorer service", () => {
  it("atomically writes an existing text file at the expected revision", async () => {
    const root = await createTempDir("paseo-file-write-");
    try {
      const filePath = path.join(root, "notes.txt");
      await writeFile(filePath, "before", "utf8");
      const current = await getExplorerFileVersion({ root, relativePath: "notes.txt" });
      expect(current.status).toBe("ready");
      if (current.status !== "ready") return;

      const result = await writeExplorerFile({
        root,
        relativePath: "notes.txt",
        content: "after",
        expectedModifiedAt: current.modifiedAt,
        expectedRevision: current.revision,
      });

      expect(result.status).toBe("written");
      expect((await readExplorerFile({ root, relativePath: "notes.txt" })).content).toBe("after");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "preserves the original file permissions across atomic replacement",
    async () => {
      const root = await createTempDir("paseo-file-mode-");
      try {
        const filePath = path.join(root, "script.sh");
        await writeFile(filePath, "before", "utf8");
        await chmod(filePath, 0o764);
        const current = await getExplorerFileVersion({ root, relativePath: "script.sh" });
        expect(current.status).toBe("ready");
        if (current.status !== "ready") return;

        const result = await writeExplorerFile({
          root,
          relativePath: "script.sh",
          content: "after",
          expectedModifiedAt: current.modifiedAt,
          expectedRevision: current.revision,
        });

        expect(result.status).toBe("written");
        expect((await stat(filePath)).mode & 0o7777).toBe(0o764);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("preserves a newer disk revision instead of overwriting it", async () => {
    const root = await createTempDir("paseo-file-conflict-");
    try {
      const filePath = path.join(root, "notes.txt");
      await writeFile(filePath, "newer on disk", "utf8");

      const result = await writeExplorerFile({
        root,
        relativePath: "notes.txt",
        content: "stale local edit",
        expectedModifiedAt: "2020-01-01T00:00:00.000Z",
      });

      expect(result).toMatchObject({ status: "conflict", version: { status: "ready" } });
      expect((await readExplorerFile({ root, relativePath: "notes.txt" })).content).toBe(
        "newer on disk",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prefers the high-precision revision token over the display timestamp", async () => {
    const root = await createTempDir("paseo-file-revision-");
    try {
      const filePath = path.join(root, "notes.txt");
      await writeFile(filePath, "on disk", "utf8");
      const current = await getExplorerFileVersion({ root, relativePath: "notes.txt" });
      expect(current.status).toBe("ready");
      if (current.status !== "ready") return;

      const result = await writeExplorerFile({
        root,
        relativePath: "notes.txt",
        content: "stale local edit",
        expectedModifiedAt: current.modifiedAt,
        expectedRevision: `${current.revision}-stale`,
      });

      expect(result.status).toBe("conflict");
      expect((await readExplorerFile({ root, relativePath: "notes.txt" })).content).toBe("on disk");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never creates a missing file through the write API", async () => {
    const root = await createTempDir("paseo-file-missing-");
    try {
      const result = await writeExplorerFile({
        root,
        relativePath: "missing.txt",
        content: "new file",
        expectedModifiedAt: "2020-01-01T00:00:00.000Z",
      });

      expect(result).toMatchObject({ status: "conflict", version: { status: "missing" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads .ex files as text", async () => {
    const root = await createTempDir("paseo-file-explorer-");

    try {
      const filePath = path.join(root, "sample.ex");
      const content = "defmodule Sample do\nend\n";
      await writeFile(filePath, content, "utf-8");

      const result = await readExplorerFile({
        root,
        relativePath: "sample.ex",
      });

      expect(result.kind).toBe("text");
      expect(result.encoding).toBe("utf-8");
      expect(result.mimeType).toBe("text/plain");
      expect(result.content).toBe(content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads unknown extension text files as text", async () => {
    const root = await createTempDir("paseo-file-explorer-");

    try {
      const filePath = path.join(root, "notes.customext");
      const content = "hello from a custom text file\n";
      await writeFile(filePath, content, "utf-8");

      const result = await readExplorerFile({
        root,
        relativePath: "notes.customext",
      });

      expect(result.kind).toBe("text");
      expect(result.encoding).toBe("utf-8");
      expect(result.mimeType).toBe("text/plain");
      expect(result.content).toBe(content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies files with null bytes as binary", async () => {
    const root = await createTempDir("paseo-file-explorer-");

    try {
      const filePath = path.join(root, "blob.weird");
      await writeFile(filePath, Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6f]));

      const result = await readExplorerFile({
        root,
        relativePath: "blob.weird",
      });

      expect(result.kind).toBe("binary");
      expect(result.encoding).toBe("none");
      expect(result.content).toBeUndefined();
      expect(result.mimeType).toBe("application/octet-stream");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("expands a ~ prefix in relative paths against the user home directory", async () => {
    const root = await createHomeTempDir(".paseo-file-explorer-home-");

    try {
      const filePath = path.join(root, "sample.txt");
      await writeFile(filePath, "hello from home\n", "utf-8");

      const tildePath = `~/${path.relative(os.homedir(), filePath)}`;
      const result = await readExplorerFile({
        root,
        relativePath: tildePath,
      });

      expect(result.kind).toBe("text");
      expect(result.content).toBe("hello from home\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows home to be the scoped root for tilde file previews", async () => {
    const root = await createHomeTempDir(".paseo-file-explorer-home-root-");

    try {
      const filePath = path.join(root, "sample.txt");
      await writeFile(filePath, "hello from home root\n", "utf-8");

      const tildePath = `~/${path.relative(os.homedir(), filePath)}`;
      const result = await readExplorerFile({
        root: "~",
        relativePath: tildePath,
      });

      expect(result.kind).toBe("text");
      expect(result.path).toBe(path.relative(os.homedir(), filePath).split(path.sep).join("/"));
      expect(result.content).toBe("hello from home root\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects ~-prefixed paths that resolve outside the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-file-explorer-outside-home-"));

    try {
      await expect(
        readExplorerFile({
          root,
          relativePath: "~/some/file.txt",
        }),
      ).rejects.toThrow("Access outside of workspace is not allowed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
