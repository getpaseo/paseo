import { describe, expect, it } from "vitest";
import {
  isProvidersSnapshotHomeScope,
  normalizeProvidersSnapshotCwd,
  providersSnapshotQueryKey,
  providersSnapshotQueryRoot,
  providersSnapshotRequestOptions,
} from "./providers-snapshot-query";

describe("providers snapshot query scope", () => {
  it("normalizes blank cwd values to the home scope", () => {
    expect(normalizeProvidersSnapshotCwd(undefined)).toBeNull();
    expect(normalizeProvidersSnapshotCwd(null)).toBeNull();
    expect(normalizeProvidersSnapshotCwd("   ")).toBeNull();
    expect(isProvidersSnapshotHomeScope("")).toBe(true);
  });

  it("keeps home and workspace query keys separate under one server root", () => {
    expect(providersSnapshotQueryRoot("server-1")).toEqual(["providersSnapshot", "server-1"]);
    expect(providersSnapshotQueryKey("server-1")).toEqual([
      "providersSnapshot",
      "server-1",
      "home",
    ]);
    expect(providersSnapshotQueryKey("server-1", "/repo-a")).toEqual([
      "providersSnapshot",
      "server-1",
      "cwd",
      "/repo-a",
    ]);
  });

  it("builds request options with cwd only for workspace scopes", () => {
    expect(providersSnapshotRequestOptions({ cwd: null, providers: ["codex"] })).toEqual({
      providers: ["codex"],
    });
    expect(providersSnapshotRequestOptions({ cwd: "/repo-a", providers: ["codex"] })).toEqual({
      cwd: "/repo-a",
      providers: ["codex"],
    });
  });

  it("uses one query scope for Windows cwd values with either separator", () => {
    expect(normalizeProvidersSnapshotCwd("C:\\Users\\Ezekiel Bulver\\project")).toBe(
      "C:/Users/Ezekiel Bulver/project",
    );
    expect(providersSnapshotQueryKey("server-1", "C:\\Users\\Ezekiel Bulver\\project")).toEqual(
      providersSnapshotQueryKey("server-1", "C:/Users/Ezekiel Bulver/project"),
    );
  });
});
