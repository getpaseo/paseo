import { describe, expect, it } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import {
  reconcileWorkspaceSelection,
  resolveRemainingWorkspaceSelection,
  selectAvailableWorkspaceKeys,
  toggleWorkspaceSelection,
} from "@/components/sidebar/sidebar-workspace-selection-model";

function workspace(input: {
  serverId: string;
  workspaceId: string;
  archiving?: boolean;
}): SidebarWorkspaceEntry {
  return {
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    workspaceKey: `${input.serverId}:${input.workspaceId}`,
    archivingAt: input.archiving ? "2026-08-30T00:00:00.000Z" : null,
  } as SidebarWorkspaceEntry;
}

describe("sidebar workspace selection", () => {
  it("toggles one workspace without mutating the current selection", () => {
    const current = new Set(["server-1:workspace-1"]);

    const added = toggleWorkspaceSelection(current, "server-1:workspace-2");
    const removed = toggleWorkspaceSelection(added, "server-1:workspace-1");

    expect(current).toEqual(new Set(["server-1:workspace-1"]));
    expect(added).toEqual(new Set(["server-1:workspace-1", "server-1:workspace-2"]));
    expect(removed).toEqual(new Set(["server-1:workspace-2"]));
  });

  it("selects available workspaces and reconciles rows removed by filters", () => {
    const first = workspace({ serverId: "server-1", workspaceId: "workspace-1" });
    const second = workspace({
      serverId: "server-2",
      workspaceId: "workspace-2",
      archiving: true,
    });
    const entries = new Map([
      [first.workspaceKey, first],
      [second.workspaceKey, second],
    ]);

    expect(selectAvailableWorkspaceKeys(entries)).toEqual(new Set([first.workspaceKey]));
    expect(
      reconcileWorkspaceSelection(
        new Set([first.workspaceKey, second.workspaceKey, "missing:workspace"]),
        entries,
      ),
    ).toEqual(new Set([first.workspaceKey, second.workspaceKey]));
  });

  it("keeps canceled and failed workspaces selected after a partial archive", () => {
    const remaining = resolveRemainingWorkspaceSelection({
      selectedWorkspaceKeys: new Set(["server-1:archived", "server-1:canceled", "server-2:failed"]),
      confirmedWorkspaceKeys: new Set(["server-1:archived", "server-2:failed"]),
      failures: [
        {
          serverId: "server-2",
          workspaceId: "failed",
          error: new Error("offline"),
        },
      ],
    });

    expect(remaining).toEqual(new Set(["server-1:canceled", "server-2:failed"]));
  });
});
