import { describe, expect, it } from "vitest";
import { aggregateWorkspaceFileSystemStatuses } from "./use-workspace-file-system-status";

describe("workspace file system status", () => {
  it("prefers an available placement for a multi-host project", () => {
    expect(
      aggregateWorkspaceFileSystemStatuses([{ state: "offline" }, { state: "online" }]),
    ).toEqual({ state: "online" });
    expect(
      aggregateWorkspaceFileSystemStatuses([{ state: "error" }, { state: "connecting" }]),
    ).toEqual({ state: "connecting" });
  });

  it("returns null when no workspace file system reports status", () => {
    expect(aggregateWorkspaceFileSystemStatuses([])).toBeNull();
  });
});
