import { describe, expect, it } from "vitest";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import { prepareWorkspaceTab } from "@/utils/prepare-workspace-tab";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "/repo/worktree";
const AGENT_ID = "agent-1";

interface RecordedOpenedTab {
  key: string;
  target: WorkspaceTabTarget;
}

interface RecordedPin {
  key: string;
  agentId: string;
}

function createFakeLayout() {
  const openedTabs: RecordedOpenedTab[] = [];
  const pinnedAgents: RecordedPin[] = [];
  return {
    openedTabs,
    pinnedAgents,
    openTabFocused: (key: string, target: WorkspaceTabTarget) => {
      openedTabs.push({ key, target });
      return target.kind === "agent" ? target.agentId : null;
    },
    pinAgent: (key: string, agentId: string) => {
      pinnedAgents.push({ key, agentId });
    },
  };
}

describe("prepareWorkspaceTab", () => {
  it("opens and focuses an agent tab", () => {
    const layout = createFakeLayout();

    prepareWorkspaceTab(
      {
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        target: { kind: "agent", agentId: AGENT_ID },
      },
      layout,
    );

    expect(layout.openedTabs).toEqual([
      { key: "server-1:/repo/worktree", target: { kind: "agent", agentId: AGENT_ID } },
    ]);
    expect(layout.pinnedAgents).toEqual([]);
  });
});
