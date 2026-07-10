import { describe, expect, it } from "vitest";
import {
  areStatusModeSessionsEqual,
  selectStatusModeSessions,
  type StatusModeSession,
} from "./use-status-mode-workspaces";
import type { WorkspaceAgentActivity } from "@/utils/workspace-agent-activity";
import type { WorkspaceDescriptor } from "@/stores/session-store";

function workspaceMap(): Map<string, WorkspaceDescriptor> {
  return new Map();
}

function activityMap(): Map<string, WorkspaceAgentActivity> {
  return new Map();
}

function statusSession(input?: Partial<Omit<StatusModeSession, "serverId">>) {
  return {
    workspaces: input?.workspaces ?? workspaceMap(),
    workspaceAgentActivity: input?.workspaceAgentActivity ?? activityMap(),
  };
}

describe("status mode session selection", () => {
  it("selects only sessions needed by visible placements", () => {
    const hostA = statusSession();
    const hostB = statusSession();
    const unusedHost = statusSession();

    expect(
      selectStatusModeSessions(
        {
          "host-a": hostA,
          "host-b": hostB,
          unused: unusedHost,
        },
        ["host-b", "missing", "host-a"],
      ),
    ).toEqual([
      {
        serverId: "host-b",
        workspaces: hostB.workspaces,
        workspaceAgentActivity: hostB.workspaceAgentActivity,
      },
      {
        serverId: "host-a",
        workspaces: hostA.workspaces,
        workspaceAgentActivity: hostA.workspaceAgentActivity,
      },
    ]);
  });

  it("keeps selector output equal when only wrapper objects change", () => {
    const workspaces = workspaceMap();
    const workspaceAgentActivity = activityMap();

    const previous = selectStatusModeSessions(
      { "host-a": statusSession({ workspaces, workspaceAgentActivity }) },
      ["host-a"],
    );
    const next = selectStatusModeSessions(
      { "host-a": statusSession({ workspaces, workspaceAgentActivity }) },
      ["host-a"],
    );

    expect(previous).not.toBe(next);
    expect(areStatusModeSessionsEqual(previous, next)).toBe(true);
  });

  it("detects workspace or activity index changes for selected hosts", () => {
    const workspaceAgentActivity = activityMap();
    const previous = selectStatusModeSessions(
      { "host-a": statusSession({ workspaceAgentActivity, workspaces: workspaceMap() }) },
      ["host-a"],
    );
    const next = selectStatusModeSessions(
      { "host-a": statusSession({ workspaceAgentActivity, workspaces: workspaceMap() }) },
      ["host-a"],
    );

    expect(areStatusModeSessionsEqual(previous, next)).toBe(false);
  });
});
