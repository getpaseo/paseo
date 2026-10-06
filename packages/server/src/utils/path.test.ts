import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  areEquivalentPaths,
  createPathEquivalenceMatcher,
  createRealpathAwarePathContext,
  getRealpathAwareRelativePath,
  isPathInsideRoot,
} from "./path.js";

describe("path equivalence", () => {
  test("resolves each distinct path once across an event batch with many workspaces", () => {
    const reads: string[] = [];
    const paths = createRealpathAwarePathContext((path) => {
      reads.push(path);
      return [path];
    });
    for (let event = 0; event < 1000; event += 1) {
      const candidate = `/repo/.git/fsmonitor--daemon/cookies/${event}`;
      expect(paths.matches("/repo/.git", candidate)).toBe(false);
      for (let workspace = 0; workspace < 108; workspace += 1) {
        const root = `/repo/.git/worktrees/${workspace}`;
        expect(paths.relative(root, candidate)).toBeNull();
      }
    }
    expect(reads).toHaveLength(1109);
    expect(new Set(reads).size).toBe(reads.length);
  });

  test("discards resolved paths between batches so a symlink change is visible", () => {
    let resolved = "/first";
    const read = (path: string) => (path === "/alias" ? [path, resolved] : [path]);
    const first = createRealpathAwarePathContext(read);
    expect(first.matches("/alias", "/first")).toBe(true);
    resolved = "/second";
    expect(createRealpathAwarePathContext(read).matches("/alias", "/second")).toBe(true);
  });

  test("cached containment preserves Windows casing, aliases, and deleted paths", () => {
    const paths = createRealpathAwarePathContext((path) =>
      path === "/alias" ? [path, "/repo/.git"] : [path],
    );
    expect(paths.relative("C:\\Repo\\.git", "c:\\repo\\.git\\HEAD")).toBe("HEAD");
    expect(paths.relative("/alias", "/repo/.git/deleted.lock")).toBe("deleted.lock");
    expect(paths.inside("/alias", "/repo/.git-other/HEAD")).toBe(false);
  });

  test.each([
    ["C:/Users/Administrator/GhostFactory", "C:\\Users\\Administrator\\GhostFactory"],
    ["d:\\Projects\\paseo", "D:\\Projects\\paseo"],
    ["C:\\Users\\Administrator\\GhostFactory\\", "C:\\Users\\Administrator\\GhostFactory"],
    [String.raw`\\?\C:\Users\Administrator\GhostFactory`, "C:\\Users\\Administrator\\GhostFactory"],
    [String.raw`\\?\UNC\server\share\GhostFactory`, String.raw`\\server\share\GhostFactory`],
  ])("matches Windows-equivalent cwd forms", (left, right) => {
    expect(areEquivalentPaths(left, right)).toBe(true);
    expect(createPathEquivalenceMatcher(left)(right)).toBe(true);
  });

  test("keeps POSIX path casing significant", () => {
    expect(
      areEquivalentPaths("/Users/Administrator/GhostFactory", "/users/administrator/ghostfactory"),
    ).toBe(false);
  });

  test("checks POSIX root containment without prefix false positives", () => {
    expect(isPathInsideRoot("/opt/paseo", "/opt/paseo/node_modules/@getpaseo/server")).toBe(true);
    expect(isPathInsideRoot("/opt/paseo", "/opt/paseo-other")).toBe(false);
  });

  test("checks Windows root containment case-insensitively", () => {
    expect(
      isPathInsideRoot("C:\\Paseo\\node_modules", "c:/paseo/node_modules/@getpaseo/server"),
    ).toBe(true);
    expect(isPathInsideRoot("C:\\Paseo\\node_modules", "C:\\Paseo\\node_modules-other")).toBe(
      false,
    );
  });

  test("preserves the casing of Windows relative suffixes", () => {
    expect(getRealpathAwareRelativePath("C:\\Repo\\.git", "c:\\repo\\.git\\HEAD")).toBe("HEAD");
    expect(
      getRealpathAwareRelativePath("C:\\Repo\\.git", "c:\\repo\\.git\\refs\\heads\\FeatureCase"),
    ).toBe("refs\\heads\\FeatureCase");
  });

  test.skipIf(process.platform === "win32")(
    "derives the contained suffix from a realpath-equivalent root",
    () => {
      const tempDir = mkdtempSync(join(tmpdir(), "paseo-path-"));
      try {
        const realRoot = join(tempDir, "real-root");
        const nestedPath = join(realRoot, "packages", "app");
        const aliasRoot = join(tempDir, "root-alias");
        mkdirSync(nestedPath, { recursive: true });
        symlinkSync(realRoot, aliasRoot, "dir");

        expect(getRealpathAwareRelativePath(aliasRoot, nestedPath)).toBe(join("packages", "app"));
        expect(getRealpathAwareRelativePath(aliasRoot, tempDir)).toBeNull();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
});
