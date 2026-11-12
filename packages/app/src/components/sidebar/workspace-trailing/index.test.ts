import { describe, expect, it } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { hasSidebarWorkspaceTrailing } from "./availability";

function workspace(overrides: Partial<SidebarWorkspaceEntry> = {}): SidebarWorkspaceEntry {
  return {
    diffStat: null,
    statusEnteredAt: null,
    agentStatusCounts: { unread: 0, running: 0, read: 0 },
    ...overrides,
  } as SidebarWorkspaceEntry;
}

describe("sidebar workspace trailing availability", () => {
  it("reserves the slot for agent status even when diff and timestamp are empty", () => {
    const entry = workspace();
    expect(hasSidebarWorkspaceTrailing({ workspace: entry, trailing: "agentStatus" })).toBe(true);
    expect(hasSidebarWorkspaceTrailing({ workspace: entry, trailing: "diff" })).toBe(false);
    expect(hasSidebarWorkspaceTrailing({ workspace: entry, trailing: "timestamp" })).toBe(false);
    expect(hasSidebarWorkspaceTrailing({ workspace: entry, trailing: "none" })).toBe(false);
  });

  it("keeps the existing diff and timestamp availability rules", () => {
    const entry = workspace({
      diffStat: { additions: 2, deletions: 1 },
      statusEnteredAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(hasSidebarWorkspaceTrailing({ workspace: entry, trailing: "diff" })).toBe(true);
    expect(hasSidebarWorkspaceTrailing({ workspace: entry, trailing: "timestamp" })).toBe(true);
  });
});
