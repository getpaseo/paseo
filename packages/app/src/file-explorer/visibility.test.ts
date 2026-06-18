import { describe, expect, it } from "vitest";
import type { ExplorerEntry } from "@/stores/session-store";
import { filterVisibleExplorerEntries, isHiddenExplorerPath } from "./visibility";

function makeEntry(name: string, kind: ExplorerEntry["kind"]): ExplorerEntry {
  return {
    name,
    path: name,
    kind,
    size: 0,
    modifiedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("file explorer visibility", () => {
  it("keeps dot-prefixed entries when hidden files are shown", () => {
    const entries = [makeEntry(".env", "file"), makeEntry("src", "directory")];

    expect(filterVisibleExplorerEntries(entries, true)).toEqual(entries);
  });

  it("hides dot-prefixed files and directories when hidden files are not shown", () => {
    const entries = [
      makeEntry(".env", "file"),
      makeEntry(".git", "directory"),
      makeEntry("README.md", "file"),
      makeEntry("src", "directory"),
    ];

    expect(filterVisibleExplorerEntries(entries, false).map((entry) => entry.name)).toEqual([
      "README.md",
      "src",
    ]);
  });

  it("detects paths nested under dot-prefixed directories", () => {
    expect(isHiddenExplorerPath(".")).toBe(false);
    expect(isHiddenExplorerPath("..")).toBe(false);
    expect(isHiddenExplorerPath("../sibling")).toBe(false);
    expect(isHiddenExplorerPath("src/components")).toBe(false);
    expect(isHiddenExplorerPath(".git")).toBe(true);
    expect(isHiddenExplorerPath("src/.cache/output.json")).toBe(true);
  });
});
