import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listDirectoryEntries, readExplorerFile } from "./service.js";

async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("file explorer service", () => {
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

  it("classifies unknown extensions with null bytes as binary", async () => {
    const root = await createTempDir("paseo-file-explorer-");
    try {
      await writeFile(
        path.join(root, "mystery.data"),
        Buffer.from([0x01, 0x00, 0x02, 0x03, 0x04])
      );

      const file = await readExplorerFile({
        root,
        relativePath: "mystery.data",
      });

      expect(file.kind).toBe("binary");
      expect(file.encoding).toBe("none");
      expect(file.tokens).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats unknown non-binary files as text", async () => {
    const root = await createTempDir("paseo-file-explorer-");
    try {
      await writeFile(path.join(root, "notes.unknown"), "hello\nworld\n", "utf-8");

      const file = await readExplorerFile({
        root,
        relativePath: "notes.unknown",
      });

      expect(file.kind).toBe("text");
      expect(file.encoding).toBe("utf-8");
      expect(file.content).toBe("hello\nworld\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns syntax tokens for supported text files below the size cap", async () => {
    const root = await createTempDir("paseo-file-explorer-");
    try {
      await writeFile(path.join(root, "example.ts"), "const value = 1;\n", "utf-8");

      const file = await readExplorerFile({
        root,
        relativePath: "example.ts",
      });

      expect(file.kind).toBe("text");
      expect(file.tokens).toBeDefined();
      expect(file.tokens?.[0]?.length ?? 0).toBeGreaterThan(0);

      const firstLine = file.content?.split("\n")[0] ?? "";
      const keyword = file.tokens?.[0]?.find(
        (token) => firstLine.slice(token.start, token.end) === "const"
      );
      expect(keyword?.style).toBe("keyword");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips syntax tokens for supported files above the size cap", async () => {
    const root = await createTempDir("paseo-file-explorer-");
    try {
      const line = "const value = 1;\n";
      const oversized = line.repeat(16_000); // > 200KB
      await writeFile(path.join(root, "big.ts"), oversized, "utf-8");

      const file = await readExplorerFile({
        root,
        relativePath: "big.ts",
      });

      expect(file.kind).toBe("text");
      expect(file.size).toBeGreaterThan(200 * 1024);
      expect(file.tokens).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
