// POSIX-only: symlink fixtures
/* eslint-disable max-nested-callbacks */
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listDirectoryEntries, readExplorerFile } from "./service.js";
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
});
