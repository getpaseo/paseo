import { describe, expect, it } from "vitest";
import { buildWorkspaceArchiveResult } from "./archive.js";

describe("workspace archive receipt", () => {
  it.each([
    { removedDirectory: true, expected: true },
    { removedDirectory: false, expected: false },
    { removedDirectory: undefined, expected: null },
  ])("returns cleanup result $expected", ({ removedDirectory, expected }) => {
    expect(
      buildWorkspaceArchiveResult("workspace-1", {
        archivedAt: "2026-08-09T00:00:00.000Z",
        removedDirectory,
      }),
    ).toEqual({
      workspaceId: "workspace-1",
      status: "archived",
      archivedAt: "2026-08-09T00:00:00.000Z",
      removedDirectory: expected,
    });
  });
});
