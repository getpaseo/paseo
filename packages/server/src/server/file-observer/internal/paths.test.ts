import { sep } from "node:path";
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

  // `createObserverPaths`'s `platform` argument only controls comparable()'s
  // case-folding -- `sep` comes from a top-level `node:path` import, fixed
  // to the host OS regardless of `platform`. This exercises the win32
  // case-insensitive half specifically (mismatched drive-letter and file
  // name casing), using the host's own separator; it cannot exercise
  // backslash-separated paths without actually running on Windows.
  test("collapses win32 paths case-insensitively even with mismatched casing", () => {
    const paths = createObserverPaths("win32");
    const parent = `C:${sep}repo${sep}packages${sep}app`;
    const sibling = `C:${sep}repo${sep}packages${sep}APP-web`;
    const descendant = `c:${sep}repo${sep}packages${sep}app${sep}src`;

    expect(paths.collapse([parent, sibling, descendant]).sort()).toEqual([parent, sibling].sort());
  });
});
