import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { shallow } from "zustand/shallow";
import { getAgentTabsNeedingOpenLabel, selectOpenTabAgents } from "./open-tab-labels";

const label = "paseo.open-agent-tab.client-1";

function tab(agentId: string, createdAt: number): WorkspaceTab {
  return { tabId: `agent_${agentId}`, target: { kind: "agent", agentId }, createdAt };
}

function agent(input: { id: string; parentAgentId?: string | null; open?: boolean }): Agent {
  return {
    id: input.id,
    parentAgentId: input.parentAgentId ?? null,
    labels: input.open ? { [label]: "true" } : {},
  } as Agent;
}

describe("getAgentTabsNeedingOpenLabel", () => {
  it("marks every present parented tab, regardless of tab order or focus", () => {
    const agents = new Map([
      ["background-child", agent({ id: "background-child", parentAgentId: "parent" })],
      ["focused-child", agent({ id: "focused-child", parentAgentId: "parent" })],
      ["root", agent({ id: "root" })],
    ]);

    expect(
      getAgentTabsNeedingOpenLabel({
        tabs: [tab("background-child", 1), tab("root", 2), tab("focused-child", 3)],
        getAgent: (agentId) => agents.get(agentId),
        label,
        pendingAgentIds: new Set(),
      }),
    ).toEqual(["background-child", "focused-child"]);
  });

  it("skips tabs already marked or currently being marked", () => {
    const agents = new Map([
      ["marked", agent({ id: "marked", parentAgentId: "parent", open: true })],
      ["pending", agent({ id: "pending", parentAgentId: "parent" })],
    ]);

    expect(
      getAgentTabsNeedingOpenLabel({
        tabs: [tab("marked", 1), tab("pending", 2)],
        getAgent: (agentId) => agents.get(agentId),
        label,
        pendingAgentIds: new Set(["pending"]),
      }),
    ).toEqual([]);
  });
});

describe("selectOpenTabAgents", () => {
  function stateWith(agents: Agent[]) {
    return {
      sessions: {
        srv: { agents: new Map(agents.map((entry) => [entry.id, entry])), agentDetails: new Map() },
      },
    };
  }

  it("stays equal when only an agent without an open tab changes", () => {
    const open = agent({ id: "open" });
    const before = selectOpenTabAgents(stateWith([open, agent({ id: "elsewhere" })]), {
      serverId: "srv",
      agentIds: ["open"],
    });
    const after = selectOpenTabAgents(stateWith([open, agent({ id: "elsewhere" })]), {
      serverId: "srv",
      agentIds: ["open"],
    });

    expect(shallow(before, after)).toBe(true);
  });

  it("changes when an agent with an open tab changes", () => {
    const elsewhere = agent({ id: "elsewhere" });
    const before = selectOpenTabAgents(stateWith([agent({ id: "open" }), elsewhere]), {
      serverId: "srv",
      agentIds: ["open"],
    });
    const after = selectOpenTabAgents(stateWith([agent({ id: "open" }), elsewhere]), {
      serverId: "srv",
      agentIds: ["open"],
    });

    expect(shallow(before, after)).toBe(false);
  });

  it("falls back to agent details and returns null for unknown agents", () => {
    const detail = agent({ id: "detail" });
    const state = {
      sessions: {
        srv: { agents: new Map<string, Agent>(), agentDetails: new Map([["detail", detail]]) },
      },
    };

    expect(
      selectOpenTabAgents(state, { serverId: "srv", agentIds: ["detail", "missing"] }),
    ).toEqual([detail, null]);
  });
});
