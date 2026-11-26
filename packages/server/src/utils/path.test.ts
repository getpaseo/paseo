import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  areEquivalentPaths,
  createPathContainmentMatcher,
  createPathEquivalenceMatcher,
  getRealpathAwareRelativePath,
  isPathInsideRoot,
} from "./path.js";

describe("path equivalence", () => {
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

  test.each([
    { root: "/repo", candidate: "/repo/..notes.txt", inside: true },
    { root: "/repo", candidate: "/repo/..drafts/notes.md", inside: true },
    { root: "/repo", candidate: "/repo/...drafts/notes.md", inside: true },
    { root: "/repo", candidate: "/repo/docs/..notes.txt", inside: true },
    { root: "/repo", candidate: "/repo", inside: true },
    { root: "/repo", candidate: "/repo/../sibling/notes.md", inside: false },
    { root: "/repo", candidate: "/repo/..drafts/../../outside.txt", inside: false },
    { root: "/repo", candidate: "/repo-other/notes.md", inside: false },
    { root: "C:\\Repo", candidate: "c:/repo/..notes.txt", inside: true },
    { root: "C:\\Repo", candidate: "C:\\Repo\\..drafts\\notes.md", inside: true },
    { root: "C:\\Repo", candidate: "C:\\Repo\\...drafts\\notes.md", inside: true },
    { root: "C:\\Repo", candidate: "C:\\Repo\\..\\sibling\\notes.md", inside: false },
    { root: "C:\\Repo", candidate: "C:\\Repo-other\\notes.md", inside: false },
    { root: "C:\\Repo", candidate: "D:\\Repo\\..notes.txt", inside: false },
    {
      root: String.raw`\\server\share\repo`,
      candidate: String.raw`\\server\share\repo\..drafts\notes.md`,
      inside: true,
    },
    {
      root: String.raw`\\?\C:\Repo`,
      candidate: "C:\\Repo\\..notes.txt",
      inside: true,
    },
  ])("checks named path containment for $candidate", ({ root, candidate, inside }) => {
    expect(isPathInsideRoot(root, candidate)).toBe(inside);
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

describe("indexed path containment", () => {
  test("preserves POSIX case and component boundaries for ancestor and exact checks", () => {
    const matcher = createPathContainmentMatcher({
      roots: ["/repo/Build/", "/repo/cache"],
      compareAsWindows: false,
    });
    expect(matcher.matches("/repo/Build/nested/file")).toBe(true);
    expect(matcher.matches("/repo/cache")).toBe(true);
    expect(matcher.matches("/repo/Build-sibling/file")).toBe(false);
    expect(matcher.matches("/repo/build/file")).toBe(false);
    expect(matcher.matches("/repo")).toBe(false);

    expect(matcher.matchesExact("/repo/Build")).toBe(true);
    expect(matcher.matchesExact("/repo/Build/")).toBe(true);
    expect(matcher.matchesExact("/repo/cache")).toBe(true);
    expect(matcher.matchesExact("/repo/Build/nested/file")).toBe(false);
    expect(matcher.matchesExact("/repo/build")).toBe(false);
  });

  test("normalizes Windows case, separators and extended namespaces", () => {
    const matcher = createPathContainmentMatcher({
      roots: ["C:/Repo/Build", String.raw`\\server\share\cache`],
      compareAsWindows: true,
    });
    expect(matcher.matches(String.raw`\\?\C:\REPO\build\file`)).toBe(true);
    expect(matcher.matches(String.raw`\\?\UNC\SERVER\SHARE\Cache\file`)).toBe(true);
    expect(matcher.matches("C:/Repo/Build-Sibling/file")).toBe(false);
    expect(matcher.matches(String.raw`\\server\share\cache-sibling\file`)).toBe(false);

    expect(matcher.matchesExact(String.raw`\\?\C:\REPO\build`)).toBe(true);
    expect(matcher.matchesExact(String.raw`\\?\UNC\SERVER\SHARE\Cache`)).toBe(true);
    expect(matcher.matchesExact(String.raw`\\?\C:\REPO\build\file`)).toBe(false);
  });

  test("handles filesystem roots and empty sets", () => {
    const posixRoot = createPathContainmentMatcher({ roots: ["/"], compareAsWindows: false });
    expect(posixRoot.matches("/repo/file")).toBe(true);
    expect(posixRoot.matchesExact("/")).toBe(true);
    expect(posixRoot.matchesExact("/repo")).toBe(false);

    const winRoot = createPathContainmentMatcher({ roots: ["C:/"], compareAsWindows: true });
    expect(winRoot.matches("c:/repo/file")).toBe(true);
    expect(winRoot.matchesExact("c:\\")).toBe(true);

    const empty = createPathContainmentMatcher({ roots: [], compareAsWindows: false });
    expect(empty.matches("/repo/file")).toBe(false);
    expect(empty.matchesExact("/repo/file")).toBe(false);
  });
});
