import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import { openAgentTab } from "@/utils/open-agent-tab";

function agent(input: Partial<Agent> & Pick<Agent, "id">): Agent {
  return {
    id: input.id,
    parentAgentId: input.parentAgentId ?? null,
    workspaceId: input.workspaceId,
  } as Agent;
}

function createWorld(agents: Agent[]) {
  const events: string[] = [];
  return {
    events,
    deps: {
      getAgent: (agentId: string) => agents.find((item) => item.id === agentId),
      getClientId: async () => "client-1",
      markOpen: async (agentId: string, label: string) => {
        events.push(`mark:${agentId}:${label}`);
      },
      open: () => {
        events.push("open");
        return "route";
      },
    },
  };
}

describe("openAgentTab", () => {
  it("marks a same-workspace child before opening it", async () => {
    const world = createWorld([
      agent({ id: "parent", workspaceId: "workspace-1" }),
      agent({ id: "child", parentAgentId: "parent", workspaceId: "workspace-1" }),
    ]);

    await expect(openAgentTab("child", world.deps)).resolves.toBe("route");
    expect(world.events).toEqual(["mark:child:paseo.open-agent-tab.client-1", "open"]);
  });

  it("opens roots and cross-workspace children without marking them", async () => {
    const rootWorld = createWorld([agent({ id: "root", workspaceId: "workspace-1" })]);
    await openAgentTab("root", rootWorld.deps);
    expect(rootWorld.events).toEqual(["open"]);

    const crossWorkspaceWorld = createWorld([
      agent({ id: "parent", workspaceId: "workspace-1" }),
      agent({ id: "child", parentAgentId: "parent", workspaceId: "workspace-2" }),
    ]);
    await openAgentTab("child", crossWorkspaceWorld.deps);
    expect(crossWorkspaceWorld.events).toEqual(["open"]);
  });

  it("does not open the tab when marking fails", async () => {
    const world = createWorld([
      agent({ id: "parent", workspaceId: "workspace-1" }),
      agent({ id: "child", parentAgentId: "parent", workspaceId: "workspace-1" }),
    ]);
    world.deps.markOpen = async () => {
      throw new Error("daemon detail");
    };

    await expect(openAgentTab("child", world.deps)).rejects.toThrow("daemon detail");
    expect(world.events).toEqual([]);
  });
});
