import { describe, expect, it } from "vitest";
import {
  areStatusModeSessionsEqual,
  selectStatusModeSessions,
  type StatusModeSession,
} from "./use-status-mode-workspaces";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";

function workspaceMap(): Map<string, WorkspaceDescriptor> {
  return new Map();
}

function agentMap(): Map<string, Agent> {
  return new Map();
}

function statusSession(input?: Partial<Omit<StatusModeSession, "serverId">>) {
  return {
    workspaces: input?.workspaces ?? workspaceMap(),
    agents: input?.agents ?? agentMap(),
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
      { serverId: "host-b", workspaces: hostB.workspaces, agents: hostB.agents },
      { serverId: "host-a", workspaces: hostA.workspaces, agents: hostA.agents },
    ]);
  });

  it("keeps selector output equal when only wrapper objects change", () => {
    const workspaces = workspaceMap();
    const agents = agentMap();

    const previous = selectStatusModeSessions({ "host-a": statusSession({ workspaces, agents }) }, [
      "host-a",
    ]);
    const next = selectStatusModeSessions({ "host-a": statusSession({ workspaces, agents }) }, [
      "host-a",
    ]);

    expect(previous).not.toBe(next);
    expect(areStatusModeSessionsEqual(previous, next)).toBe(true);
  });

  it("detects workspace or agent map changes for selected hosts", () => {
    const agents = agentMap();
    const previous = selectStatusModeSessions(
      { "host-a": statusSession({ agents, workspaces: workspaceMap() }) },
      ["host-a"],
    );
    const next = selectStatusModeSessions(
      { "host-a": statusSession({ agents, workspaces: workspaceMap() }) },
      ["host-a"],
    );

    expect(areStatusModeSessionsEqual(previous, next)).toBe(false);
  });
});
