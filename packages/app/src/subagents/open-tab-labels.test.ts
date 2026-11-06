import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@/stores/session-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import {
  getAgentTabsNeedingOpenLabel,
  createAgentTabsNeedingOpenLabelKeySelector,
  type AgentMapsState,
} from "./open-tab-labels";

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

describe("createAgentTabsNeedingOpenLabelKeySelector", () => {
  const tabs = [tab("child", 1), tab("root", 2)];

  function snapshot(agents: Map<string, Agent>): AgentMapsState {
    return { sessions: { s: { agents, agentDetails: new Map() } } };
  }

  function create() {
    return createAgentTabsNeedingOpenLabelKeySelector({ serverId: "s", tabs, label });
  }

  it("keeps the same value when an agent outside the open tabs updates", () => {
    const select = create();
    const before = new Map([
      ["child", agent({ id: "child", parentAgentId: "parent" })],
      ["root", agent({ id: "root" })],
      ["elsewhere", agent({ id: "elsewhere" })],
    ]);
    const after = new Map(before);
    after.set("elsewhere", agent({ id: "elsewhere", parentAgentId: "root" }));

    expect(select(snapshot(before))).toBe("child");
    expect(select(snapshot(after))).toBe("child");
  });

  it("changes once the open child carries the label", () => {
    const select = create();
    const agents = new Map([
      ["child", agent({ id: "child", parentAgentId: "parent", open: true })],
      ["root", agent({ id: "root" })],
    ]);

    expect(select(snapshot(agents))).toBe("");
  });

  it("does no work on store updates that leave the agent maps unchanged", () => {
    const select = create();
    const agents = new Map([["child", agent({ id: "child", parentAgentId: "parent" })]]);
    const state = snapshot(agents);
    const get = vi.spyOn(agents, "get");

    expect(select(state)).toBe("child");
    const lookups = get.mock.calls.length;
    expect(select({ ...state })).toBe("child");
    expect(get.mock.calls.length).toBe(lookups);
  });
});
