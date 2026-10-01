import { beforeEach, expect, it, vi } from "vitest";
import { collectAllTabs } from "@/stores/workspace-layout-store";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";

const mocks = vi.hoisted(() => ({
  move: vi.fn(),
  navigate: vi.fn(),
  agents: new Map<string, { id: string; workspaceId: string; archivedAt: string | null }>(),
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getClient: () => ({ moveAgentToWorkspace: mocks.move }) }),
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: mocks.navigate,
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: { getState: () => ({ sessions: { srv: { agents: mocks.agents } } }) },
}));
vi.mock("@/stores/workspace-layout-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/workspace-layout-store")>();
  return { ...actual, useWorkspaceLayoutStore: actual.createWorkspaceLayoutStore() };
});
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { moveSessionToWorkspace, moveWorkspaceSessions } from "./move-sessions";

beforeEach(() => {
  mocks.move.mockReset().mockResolvedValue(undefined);
  mocks.navigate.mockReset();
  mocks.agents.clear();
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    pinnedAgentIdsByWorkspace: {},
    hiddenAgentIdsByWorkspace: {},
    focusRestorationByWorkspace: {},
  });
  useSidebarOrderStore.setState({
    projectOrder: [],
    pinnedWorkspaceOrder: [],
    workspaceOrderByProject: {},
    workspacePromotedAt: {},
  });
});

it("moves an existing session to the front, reveals hidden target tabs and cleans source tabs", async () => {
  mocks.agents.set("moved", { id: "moved", workspaceId: "source", archivedAt: null });
  const store = useWorkspaceLayoutStore.getState();
  for (const [workspaceKey, agentId] of [
    ["srv:source", "moved"],
    ["srv:target", "existing"],
    ["srv:target", "moved"],
  ]) {
    store.openTab({
      workspaceKey: workspaceKey!,
      target: { kind: "agent", agentId: agentId! },
      intent: "reveal",
      pin: true,
    });
  }
  store.hideAgent("srv:target", "moved");
  await moveSessionToWorkspace({ serverId: "srv", agentId: "moved", targetWorkspaceId: "target" });
  const state = useWorkspaceLayoutStore.getState();
  expect(
    collectAllTabs(state.layoutByWorkspace["srv:source"]!.root).filter(
      (tab) => tab.target.kind === "agent",
    ),
  ).toEqual([]);
  expect(
    collectAllTabs(state.layoutByWorkspace["srv:target"]!.root)
      .filter((tab) => tab.target.kind === "agent")
      .map((tab) => tab.target),
  ).toEqual([
    { kind: "agent", agentId: "moved" },
    { kind: "agent", agentId: "existing" },
  ]);
  expect(state.hiddenAgentIdsByWorkspace["srv:target"]?.has("moved") ?? false).toBe(false);
  expect(state.pinnedAgentIdsByWorkspace["srv:source"]?.has("moved") ?? false).toBe(false);
  expect(mocks.navigate).toHaveBeenCalledWith({
    serverId: "srv",
    workspaceId: "target",
    target: { kind: "agent", agentId: "moved" },
  });
});

it("keeps source and target layouts when the host refuses the move", async () => {
  const store = useWorkspaceLayoutStore.getState();
  store.openTab({
    workspaceKey: "srv:source",
    target: { kind: "agent", agentId: "moved" },
    intent: "reveal",
  });
  const before = useWorkspaceLayoutStore.getState().layoutByWorkspace;
  mocks.move.mockRejectedValue(new Error("refused"));
  await expect(
    moveSessionToWorkspace({ serverId: "srv", agentId: "moved", targetWorkspaceId: "target" }),
  ).rejects.toThrow("refused");
  expect(useWorkspaceLayoutStore.getState().layoutByWorkspace).toBe(before);
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it("opens every moved session first in source order, excluding archived sessions", async () => {
  for (const [id, archivedAt] of [
    ["first", null],
    ["second", null],
    ["archived", "2026-01-01"],
  ])
    mocks.agents.set(id!, { id: id!, workspaceId: "source", archivedAt });
  useWorkspaceLayoutStore.getState().openTab({
    workspaceKey: "srv:target",
    target: { kind: "agent", agentId: "existing" },
    intent: "reveal",
  });
  expect(
    await moveWorkspaceSessions({
      serverId: "srv",
      sourceWorkspaceId: "source",
      targetWorkspaceId: "target",
    }),
  ).toEqual({ moved: 2 });
  expect(mocks.move.mock.calls).toEqual([
    ["second", "target"],
    ["first", "target"],
  ]);
  expect(
    collectAllTabs(useWorkspaceLayoutStore.getState().layoutByWorkspace["srv:target"]!.root)
      .filter((tab) => tab.target.kind === "agent")
      .map((tab) => tab.target),
  ).toEqual([
    { kind: "agent", agentId: "first" },
    { kind: "agent", agentId: "second" },
    { kind: "agent", agentId: "existing" },
  ]);
  expect(mocks.navigate).toHaveBeenCalledTimes(1);
});
