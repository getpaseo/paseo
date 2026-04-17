import { describe, expect, it } from "vitest";
import { providersSnapshotQueryKey } from "./use-providers-snapshot";

describe("providersSnapshotQueryKey", () => {
  it("includes cwd in the cache key", () => {
    expect(providersSnapshotQueryKey("server-1", "E:\\evolution")).toEqual([
      "providersSnapshot",
      "server-1",
      "E:/evolution",
    ]);
  });

  it("normalizes Windows separators so equivalent cwd values share a key", () => {
    expect(providersSnapshotQueryKey("server-1", "E:\\lzzy")).toEqual(
      providersSnapshotQueryKey("server-1", "E:/lzzy"),
    );
  });

  it("keeps different cwd values isolated under the same server", () => {
    expect(providersSnapshotQueryKey("server-1", "E:\\evolution")).not.toEqual(
      providersSnapshotQueryKey("server-1", "E:\\lzzy"),
    );
  });

  it("falls back to a server-level cache entry when cwd is absent", () => {
    expect(providersSnapshotQueryKey("server-1")).toEqual(["providersSnapshot", "server-1", null]);
  });
});
