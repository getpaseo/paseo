import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { i18n as testI18n } from "@/i18n/i18next";
import { hasSidebarWorkspaceTrailing, SidebarWorkspaceTrailingContent } from "./index";

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.mock("@/components/diff-stat", () => ({ DiffStat: () => null }));
vi.mock("@/hooks/use-time-ago", () => ({ useCompactTimeAgo: () => "1m" }));
vi.mock("@/hooks/use-settings", () => ({
  useAppSettings: () => ({ settings: { sidebarWorkspaceTrailing: "agentStatus" } }),
}));

function workspace(overrides: Partial<SidebarWorkspaceEntry> = {}): SidebarWorkspaceEntry {
  return {
    diffStat: null,
    statusEnteredAt: null,
    agentStatusCounts: { unread: 0, running: 0, read: 0 },
    ...overrides,
  } as SidebarWorkspaceEntry;
}

describe("sidebar workspace trailing", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(async () => {
    await testI18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it("draws nothing when every count is zero", () => {
    act(() => {
      root?.render(
        <SidebarWorkspaceTrailingContent workspace={workspace()} trailing="agentStatus" />,
      );
    });

    expect(
      container?.querySelector('[data-testid="sidebar-workspace-agent-status-counts"]'),
    ).toBeNull();
  });

  it("hides zeroes but keeps one slot per count so the columns stay put", () => {
    act(() => {
      root?.render(
        <SidebarWorkspaceTrailingContent
          workspace={workspace({
            agentStatusCounts: { unread: 2, running: 0, read: 7 },
          })}
          trailing="agentStatus"
        />,
      );
    });

    const counts = container?.querySelector(
      '[data-testid="sidebar-workspace-agent-status-counts"]',
    );
    expect(counts?.textContent).toBe("27");
    expect(counts?.getAttribute("aria-label")).toBe("2 unread, 0 running, 7 read");
  });

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
