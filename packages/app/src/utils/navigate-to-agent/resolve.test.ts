import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  resolveNavigateToAgent,
  type AgentNavTarget,
  type NavigateToAgentDeps,
} from "@/utils/navigate-to-agent/resolve";
import type { NavigateToPreparedWorkspaceTabInput } from "@/utils/prepare-workspace-tab";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "workspace-1";
const AGENT_ID = "agent-1";

function createWorkspace(): WorkspaceDescriptor {
  return {
    id: WORKSPACE_ID,
    projectId: "project-1",
    projectDisplayName: "Project",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo/worktree",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "worktree",
    status: "done",
    archivingAt: null,
    statusEnteredAt: null,
    diffStat: null,
    scripts: [],
  };
}

interface RecordedHostNav {
  route: string;
}

interface RecordedTabNav extends NavigateToPreparedWorkspaceTabInput {}

function createFakeNavigators(target: AgentNavTarget): {
  deps: NavigateToAgentDeps;
  hostNavigations: RecordedHostNav[];
  tabNavigations: RecordedTabNav[];
} {
  const hostNavigations: RecordedHostNav[] = [];
  const tabNavigations: RecordedTabNav[] = [];
  return {
    hostNavigations,
    tabNavigations,
    deps: {
      readAgentNavTarget: () => target,
      navigateToHostAgent: (route) => {
        hostNavigations.push({ route });
      },
      navigateToPreparedWorkspaceTab: (input) => {
        tabNavigations.push(input);
        return `/h/${input.serverId}/workspace/${input.workspaceId}`;
      },
    },
  };
}

describe("resolveNavigateToAgent", () => {
  it("opens the resolved workspace tab when the agent's cwd matches a workspace", () => {
    const { deps, hostNavigations, tabNavigations } = createFakeNavigators({
      workspaces: [createWorkspace()],
      agentCwd: "/repo/worktree",
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
        currentPathname: undefined,
        pin: true,
      },
    ]);
  });

  it("falls back to the host agent route when the workspace is unknown", () => {
    const { deps, hostNavigations, tabNavigations } = createFakeNavigators({
      workspaces: [],
      agentCwd: null,
    });

    const route = resolveNavigateToAgent({ serverId: SERVER_ID, agentId: "missing-agent" }, deps);

    expect(route).toBe("/h/server-1/agent/missing-agent");
    expect(hostNavigations).toEqual([{ route: "/h/server-1/agent/missing-agent" }]);
    expect(tabNavigations).toEqual([]);
  });
});
