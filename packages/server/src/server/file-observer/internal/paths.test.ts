import { posix, win32 } from "node:path";
import { describe, expect, test } from "vitest";
import { createObserverPaths } from "./paths.js";

// m3 regression: plain lexicographic sort does not put a parent immediately
// before its descendants. A sibling whose name extends the parent's with a
// character that sorts below the separator (POSIX "/" = 0x2F, so "-" and "."
// qualify) lands between them, so the single backward look collapse()
// relies on misses the real parent and keeps a redundant descendant scope.
// This is this repo's own layout: packages/app, packages/app-web,
// packages/app/src.
describe("collapse", () => {
  test("drops a redundant descendant but keeps a sibling whose name extends the parent's", () => {
    const paths = createObserverPaths("linux");
    const parent = "/repo/packages/app";
    const sibling = "/repo/packages/app-web";
    const descendant = "/repo/packages/app/src";

    expect(paths.collapse([parent, sibling, descendant]).sort()).toEqual([parent, sibling].sort());
  });

  test("keeps unrelated roots and drops nested duplicates regardless of input order", () => {
    const paths = createObserverPaths("linux");
    const a = "/repo/a";
    const aChild = "/repo/a/child";
    const b = "/repo/b";

    expect(paths.collapse([aChild, b, a]).sort()).toEqual([a, b].sort());
  });

  // The selected path strategy supplies separators and case comparison, so
  // Windows paths can be checked on every CI host.
  test("collapses win32 paths case-insensitively even with mismatched casing", () => {
    const paths = createObserverPaths("win32");
    const sep = win32.sep;
    const parent = `C:${sep}repo${sep}packages${sep}app`;
    const sibling = `C:${sep}repo${sep}packages${sep}APP-web`;
    const descendant = `c:${sep}repo${sep}packages${sep}app${sep}src`;

    expect(paths.collapse([parent, sibling, descendant]).sort()).toEqual([parent, sibling].sort());
  });
});

describe("ignored root matching", () => {
  test.each(["linux", "win32"] as const)(
    "matches ancestors, exact roots, and sibling boundaries on %s",
    (platform) => {
      const paths = createObserverPaths(platform);
      const root = platform === "win32" ? "C:\\repo" : "/repo";
      const api = platform === "win32" ? win32 : posix;
      const ignored = api.join(root, "output");
      const matcher = paths.createIgnoreMatcher([ignored]);
      expect(matcher.matches(ignored)).toBe(true);
      expect(matcher.matches(api.join(ignored, "nested", "file.txt"))).toBe(true);
      expect(matcher.matches(api.join(root, "output-sibling", "file.txt"))).toBe(false);
      expect(matcher.matches(root)).toBe(false);
      expect(matcher.matches(api.join(root, "src", "file.txt"))).toBe(false);

      expect(matcher.matchesExact(ignored)).toBe(true);
      expect(matcher.matchesExact(api.join(ignored, "nested"))).toBe(false);
      expect(matcher.matchesExact(api.join(root, "output-sibling"))).toBe(false);

      if (platform === "win32") {
        expect(matcher.matches(api.join(ignored, "nested", "file.txt").toUpperCase())).toBe(true);
        expect(matcher.matchesExact(ignored.toUpperCase())).toBe(true);
      }
    },
  );

  test("an empty ignore set rejects no paths", () => {
    const matcher = createObserverPaths("linux").createIgnoreMatcher([]);
    expect(matcher.matches("/repo/file.txt")).toBe(false);
    expect(matcher.matchesExact("/repo/file.txt")).toBe(false);
  });
});
