import { describe, expect, it } from "vitest";
import {
  resolveNavigateToAgent,
  type AgentNavTarget,
  type NavigateToAgentDeps,
} from "@/utils/navigate-to-agent/resolve";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "workspace-1";
const AGENT_ID = "agent-1";

interface RecordedHostNav {
  route: string;
}

interface RecordedTabNav extends NavigateToWorkspaceInput {}

interface RecordedRestore {
  serverId: string;
  agentId: string;
  workspaceId: string;
}

function createFakeNavigators(target: AgentNavTarget): {
  deps: NavigateToAgentDeps;
  hostNavigations: RecordedHostNav[];
  tabNavigations: RecordedTabNav[];
  restores: RecordedRestore[];
} {
  const hostNavigations: RecordedHostNav[] = [];
  const tabNavigations: RecordedTabNav[] = [];
  const restores: RecordedRestore[] = [];
  return {
    hostNavigations,
    tabNavigations,
    restores,
    deps: {
      readAgentNavTarget: () => target,
      navigateToHostAgent: (route) => {
        hostNavigations.push({ route });
      },
      navigateToWorkspace: (input) => {
        tabNavigations.push(input);
        return `/h/${input.serverId}/workspace/${input.workspaceId}`;
      },
      restoreArchivedWorkspace: (input) => {
        restores.push(input);
      },
    },
  };
}

describe("resolveNavigateToAgent", () => {
  it("opens the workspace tab carried by the agent's workspaceId", () => {
    const { deps, hostNavigations, tabNavigations } = createFakeNavigators({
      agentWorkspaceId: WORKSPACE_ID,
    });

    const route = resolveNavigateToAgent(
      { serverId: SERVER_ID, agentId: AGENT_ID, pin: true },
      deps,
    );

    expect(route).toBe("/h/server-1/workspace/workspace-1");
    expect(hostNavigations).toEqual([]);
    expect(tabNavigations).toEqual([
      {
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        target: { kind: "agent", agentId: AGENT_ID },
        pin: true,
      },
    ]);
  });

  it("delegates a restore attempt whenever a workspaceId resolves", () => {
    const { deps, restores, tabNavigations } = createFakeNavigators({
      agentWorkspaceId: WORKSPACE_ID,
    });

    resolveNavigateToAgent({ serverId: SERVER_ID, agentId: AGENT_ID, pin: true }, deps);

    expect(restores).toEqual([
      { serverId: SERVER_ID, agentId: AGENT_ID, workspaceId: WORKSPACE_ID },
    ]);
    expect(tabNavigations).toHaveLength(1);
  });

  it("uses the input workspaceId without reading the nav target", () => {
    const readTargets: { serverId: string; agentId: string }[] = [];
    const { deps, tabNavigations } = createFakeNavigators({ agentWorkspaceId: null });
    deps.readAgentNavTarget = (input) => {
      readTargets.push(input);
      return { agentWorkspaceId: null };
    };

    resolveNavigateToAgent(
      { serverId: SERVER_ID, agentId: AGENT_ID, workspaceId: WORKSPACE_ID },
      deps,
    );

    expect(readTargets).toEqual([]);
    expect(tabNavigations).toEqual([
      {
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        target: { kind: "agent", agentId: AGENT_ID },
        pin: undefined,
      },
    ]);
  });

  it("does not trigger a restore when no workspaceId resolves", () => {
    const { deps, restores, hostNavigations } = createFakeNavigators({
      agentWorkspaceId: null,
    });

    resolveNavigateToAgent({ serverId: SERVER_ID, agentId: AGENT_ID }, deps);

    expect(restores).toEqual([]);
    expect(hostNavigations).toHaveLength(1);
  });

  it("falls back to the host agent route when the agent has no workspaceId", () => {
    const { deps, hostNavigations, tabNavigations } = createFakeNavigators({
      agentWorkspaceId: null,
    });

    const route = resolveNavigateToAgent({ serverId: SERVER_ID, agentId: "missing-agent" }, deps);

    expect(route).toBe("/h/server-1/agent/missing-agent");
    expect(hostNavigations).toEqual([{ route: "/h/server-1/agent/missing-agent" }]);
    expect(tabNavigations).toEqual([]);
  });
});
