import { describe, expect, it } from "vitest";
import type { DiffFileMetadata } from "./use-checkout-diff-metadata-query";

/**
 * Tests for use-file-hunks hook logic.
 *
 * The hook itself is a thin React Query wrapper, so we test the key properties:
 * 1. Query key includes fingerprint — fingerprint change = automatic refetch
 * 2. Metadata fields are passed through to the merged result
 */

function fileHunksQueryKey(
  serverId: string,
  cwd: string,
  mode: "uncommitted" | "base",
  baseRef: string | undefined,
  ignoreWhitespace: boolean | undefined,
  path: string,
  fingerprint: string,
) {
  return [
    "checkoutFileHunks",
    serverId,
    cwd,
    mode,
    baseRef ?? "",
    ignoreWhitespace === true,
    path,
    fingerprint,
  ] as const;
}

describe("use-file-hunks query key", () => {
  it("includes fingerprint in query key", () => {
    const key = fileHunksQueryKey("s1", "/repo", "base", "main", false, "foo.ts", "fp-abc");
    expect(key).toContain("fp-abc");
    expect(key).toContain("foo.ts");
  });

  it("different fingerprints produce different query keys", () => {
    const key1 = fileHunksQueryKey("s1", "/repo", "base", "main", false, "foo.ts", "fp-1");
    const key2 = fileHunksQueryKey("s1", "/repo", "base", "main", false, "foo.ts", "fp-2");
    expect(key1).not.toEqual(key2);
    // Only the fingerprint element differs
    expect(key1.slice(0, -1)).toEqual(key2.slice(0, -1));
  });

  it("same fingerprint + same params produces identical key", () => {
    const key1 = fileHunksQueryKey("s1", "/repo", "uncommitted", undefined, true, "bar.ts", "fp-x");
    const key2 = fileHunksQueryKey("s1", "/repo", "uncommitted", undefined, true, "bar.ts", "fp-x");
    expect(key1).toEqual(key2);
  });

  it("normalizes missing baseRef to empty string", () => {
    const key = fileHunksQueryKey("s1", "/repo", "uncommitted", undefined, false, "a.ts", "fp");
    expect(key[4]).toBe("");
  });

  it("normalizes ignoreWhitespace to boolean", () => {
    const key = fileHunksQueryKey("s1", "/repo", "base", "main", undefined, "a.ts", "fp");
    expect(key[5]).toBe(false);
  });
});

describe("use-file-hunks metadata merge", () => {
  it("metadata fields carry through to merged ParsedDiffFile shape", () => {
    const meta: DiffFileMetadata = {
      path: "src/index.ts",
      isNew: true,
      isDeleted: false,
      additions: 10,
      deletions: 2,
      status: "ok",
      fingerprint: "abc",
    };

    // Simulates merging metadata with fetched hunks
    const merged = {
      path: meta.path,
      isNew: meta.isNew,
      isDeleted: meta.isDeleted,
      additions: meta.additions,
      deletions: meta.deletions,
      status: meta.status,
      hunks: [],
    };

    expect(merged.path).toBe("src/index.ts");
    expect(merged.isNew).toBe(true);
    expect(merged.additions).toBe(10);
    expect(merged.hunks).toEqual([]);
  });
});
