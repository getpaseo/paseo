import { describe, expect, it } from "vitest";
import type { DaemonServerInfo, WorkspaceDescriptor } from "@/stores/session-store";
import type { SidebarBatchSelectionEntry } from "@/hooks/use-sidebar-batch-actions";
import {
  buildSidebarBatchAffordances,
  selectArchivableEntries,
  selectMarkUnreadEligibleEntries,
  selectPinCapableEntries,
  selectPurgedTargets,
} from "@/hooks/use-sidebar-batch-actions";

function descriptor(overrides: Partial<WorkspaceDescriptor>): WorkspaceDescriptor {
  return {
    status: "done",
    archivingAt: null,
    pinnedAt: null,
    workspaceKind: "worktree",
    name: "workspace",
    ...overrides,
  } as WorkspaceDescriptor;
}

function entry(
  key: string,
  workspace: WorkspaceDescriptor | null,
  serverId = "s1",
): SidebarBatchSelectionEntry {
  return { serverId, workspaceId: key, workspaceKey: `${serverId}:${key}`, workspace };
}

const BOTH_FEATURES = {
  features: { workspacePinning: true, workspaceMarkUnread: true },
} as unknown as DaemonServerInfo;

const NO_FEATURES = { features: {} } as unknown as DaemonServerInfo;

const SESSIONS = {
  s1: { serverInfo: BOTH_FEATURES },
  s2: { serverInfo: NO_FEATURES },
};

const LIVE = descriptor({});

describe("selectPinCapableEntries", () => {
  it("keeps rows on hosts with the pinning feature and drops gone and archiving rows", () => {
    const entries = [
      entry("live", LIVE),
      entry("gone", null),
      entry("archiving", descriptor({ archivingAt: "2026-10-14T00:00:00Z" })),
      entry("no-feature", LIVE, "s2"),
    ];
    expect(selectPinCapableEntries(SESSIONS, entries).map((item) => item.workspaceKey)).toEqual([
      "s1:live",
    ]);
  });
});

describe("selectMarkUnreadEligibleEntries", () => {
  it("keeps only done rows on hosts with the mark-unread feature", () => {
    const entries = [
      entry("done", descriptor({ status: "done" })),
      entry("running", descriptor({ status: "running" })),
      entry("needs-input", descriptor({ status: "needs_input" })),
      entry("no-feature", descriptor({ status: "done" }), "s2"),
      entry("gone", null),
    ];
    expect(
      selectMarkUnreadEligibleEntries(SESSIONS, entries).map((item) => item.workspaceKey),
    ).toEqual(["s1:done"]);
  });
});

describe("selectArchivableEntries", () => {
  it("drops gone and already-archiving rows", () => {
    const entries = [
      entry("live", LIVE),
      entry("gone", null),
      entry("archiving", descriptor({ archivingAt: "2026-10-14T00:00:00Z" })),
    ];
    expect(selectArchivableEntries(entries).map((item) => item.workspaceKey)).toEqual(["s1:live"]);
  });
});

describe("selectPurgedTargets", () => {
  it("drops failed archives from the purge so their saved layouts survive", () => {
    const confirmed = [
      { serverId: "s1", workspaceId: "ok", workspaceKey: "s1:ok" },
      { serverId: "s1", workspaceId: "failed", workspaceKey: "s1:failed" },
      { serverId: "s2", workspaceId: "also-failed", workspaceKey: "s2:also-failed" },
    ];
    const failures = [
      { serverId: "s1", workspaceId: "failed", error: new Error("host disconnected") },
      { serverId: "s2", workspaceId: "also-failed", error: new Error("host disconnected") },
    ];
    expect(selectPurgedTargets(confirmed, failures).map((target) => target.workspaceKey)).toEqual([
      "s1:ok",
    ]);
  });

  it("purges everything when no archive fails", () => {
    const confirmed = [{ serverId: "s1", workspaceId: "a", workspaceKey: "s1:a" }];
    expect(selectPurgedTargets(confirmed, [])).toHaveLength(1);
  });
});

describe("buildSidebarBatchAffordances", () => {
  it("counts all pin-capable rows for pin and unpin, which both act on the whole set", () => {
    const entries = [
      entry("unpinned", descriptor({ pinnedAt: null })),
      entry("pinned", descriptor({ pinnedAt: "2026-10-14T00:00:00Z" })),
      entry("no-feature", descriptor({ pinnedAt: null }), "s2"),
    ];
    const affordances = buildSidebarBatchAffordances(SESSIONS, entries);
    expect(affordances).toEqual({
      count: 3,
      pinCapableCount: 2,
      unreadCount: 2,
      archivableCount: 3,
    });
  });

  it("reports zero affordances for a selection of vanished rows", () => {
    const affordances = buildSidebarBatchAffordances(SESSIONS, [entry("gone", null)]);
    expect(affordances).toEqual({
      count: 1,
      pinCapableCount: 0,
      unreadCount: 0,
      archivableCount: 0,
    });
  });
});
