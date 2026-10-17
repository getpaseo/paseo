import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { createPluginNavigation } from "@/plugins/navigation";
import { handoffReason, handoffWidgetPlan } from "./handoff";
import {
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";

const { plugins, run, navigate } = vi.hoisted(() => ({
  plugins: vi.fn(),
  run: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@/plugins/registry", () => ({ pluginRegistry: { getSnapshot: plugins } }));
vi.mock("@/plugins/plan-actions/contribution", () => ({ runPlanContribution: run }));
vi.mock("@/plugins/client-state/source", () => ({
  createPluginClientStateSource: () => ({
    getWorkspace: () => ({ id: "workspace" }),
    getAgent: () => ({ id: "planner", workspaceId: "workspace" }),
  }),
}));
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("@/stores/navigation-active-workspace-store", () => ({ navigateToWorkspace: vi.fn() }));
vi.mock("@/utils/navigate-to-agent", () => ({ navigateToAgent: navigate }));

const request: AgentPermissionRequest = {
  id: "permission",
  provider: "codex",
  name: "Plan",
  kind: "plan",
  sourcePlanCallId: "call-1",
  metadata: { planText: "# Exact plan\n\nSecond line." },
};
const action = {
  type: "handoff" as const,
  profileId: "profile-1",
  key: "request-key",
  planCallId: "call-1",
  planText: "# Exact plan\n\nSecond line.",
};
const progress = vi.fn().mockResolvedValue(undefined);
const input = {
  client: {} as Parameters<typeof handoffWidgetPlan>[0]["client"],
  bridge: { progress } as unknown as Parameters<typeof handoffWidgetPlan>[0]["bridge"],
  serverId: "host",
  agentId: "planner",
  workspaceId: "workspace",
  request,
  operationId: "operation",
  action,
};
const plugin = {
  serverId: "host",
  id: "paseo-workflow",
  lifetime: new AbortController(),
  planActions: [{ id: "handoff", title: "Handoff" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceLayoutStore.setState({ layoutByWorkspace: {}, hiddenAgentIdsByWorkspace: {} });
  plugins.mockReturnValue([plugin]);
  run.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

const backgroundCases = [false, true].flatMap((targetExists) =>
  [false, true].flatMap((sourceExists) =>
    [false, true].map((otherSelected) => ({ targetExists, sourceExists, otherSelected })),
  ),
);

describe("widget handoff", () => {
  it("shows a reason when the contribution is absent or disabled", () => {
    plugins.mockReturnValue([]);
    expect(handoffReason("host", "workspace", "call-1")).toContain("Install paseo-workflow");
    plugins.mockReturnValue([
      { ...plugin, planActions: [{ id: "handoff", disabledReason: "Unavailable" }] },
    ]);
    expect(handoffReason("host", "workspace", "call-1")).toBe("Unavailable");
  });

  it("rejects a replaced plan before invoking the plugin", async () => {
    await expect(
      handoffWidgetPlan({ ...input, action: { ...action, planText: "Older plan" } }),
    ).rejects.toThrow("replaced");
    expect(run).not.toHaveBeenCalled();
  });

  it("requires an explicit profile before invoking the plugin", async () => {
    await expect(
      handoffWidgetPlan({ ...input, action: { ...action, profileId: undefined } }),
    ).rejects.toThrow("Choose an agent profile");
    expect(run).not.toHaveBeenCalled();
  });

  it("passes the exact plan and opens an agent in the background", async () => {
    const workspaceKey = "host:workspace";
    const otherId = useWorkspaceLayoutStore
      .getState()
      .openTab({ workspaceKey, target: { kind: "agent", agentId: "other" }, intent: "new" });
    run.mockImplementation(async ({ navigation }) => navigation.openAgent?.("executor"));
    await handoffWidgetPlan(input);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        contributionId: "handoff",
        profileId: "profile-1",
        workspaceId: "workspace",
        agentId: "planner",
        plan: { callId: "call-1", text: action.planText, permissionRequestId: "permission" },
      }),
    );
    expect(navigate).not.toHaveBeenCalled();
    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId).toBe(otherId);
    expect(
      collectAllTabs(layout.root).some(
        (tab) => tab.target.kind === "agent" && tab.target.agentId === "executor",
      ),
    ).toBe(true);
  });

  it.each([false, true])(
    "replaces the source without duplicates when the executor already exists: %s",
    async (targetExists) => {
      const workspaceKey = "host:workspace";
      const store = useWorkspaceLayoutStore.getState();
      store.openTab({ workspaceKey, target: { kind: "agent", agentId: "planner" }, intent: "new" });
      if (targetExists)
        store.openTab({
          workspaceKey,
          target: { kind: "agent", agentId: "executor" },
          intent: "new",
        });
      run.mockImplementation(async ({ navigation }) =>
        navigation.replaceAgent?.("planner", "executor"),
      );
      await handoffWidgetPlan(input);
      expect(navigate).not.toHaveBeenCalled();
      const tabs = collectAllTabs(
        useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
      );
      expect(tabs.filter((tab) => tab.target.kind === "agent").map((tab) => tab.target)).toEqual([
        { kind: "agent", agentId: "executor" },
      ]);
    },
  );

  it.each(backgroundCases)(
    "uses the real contribution context in the background: %j",
    async ({ targetExists, sourceExists, otherSelected }) => {
      const workspaceKey = "host:workspace";
      const store = useWorkspaceLayoutStore.getState();
      const open = (agentId: string, key = workspaceKey) =>
        store.openTab({
          workspaceKey: key,
          target: { kind: "agent", agentId },
          intent: "new",
        })!;
      if (targetExists) open("executor");
      const sourceId = sourceExists ? open("planner") : null;
      const otherId = otherSelected ? open("other") : null;
      open("elsewhere", "host:visible-workspace");
      const visibleBefore = structuredClone(
        useWorkspaceLayoutStore.getState().layoutByWorkspace["host:visible-workspace"],
      );
      useWorkspaceLayoutStore.setState({
        pinnedAgentIdsByWorkspace: { [workspaceKey]: new Set(["planner"]) },
      });
      const onPress = vi.fn(async (context) => {
        expect(context.navigation.openAgent).toBeTypeOf("function");
        context.navigation.replaceAgent({ agentId: "executor" });
      });
      plugins.mockReturnValue([{ ...plugin, planActions: [{ id: "handoff", onPress }] }]);
      const actual = await vi.importActual<typeof import("@/plugins/plan-actions/contribution")>(
        "@/plugins/plan-actions/contribution",
      );
      run.mockImplementation(actual.runPlanContribution);
      await handoffWidgetPlan(input);
      await handoffWidgetPlan(input);
      const state = useWorkspaceLayoutStore.getState();
      const layout = state.layoutByWorkspace[workspaceKey];
      const tabs = collectAllTabs(layout.root);
      expect(
        tabs.filter((tab) => tab.target.kind === "agent" && tab.target.agentId === "executor"),
      ).toHaveLength(1);
      expect(
        tabs.some((tab) => tab.target.kind === "agent" && tab.target.agentId === "planner"),
      ).toBe(false);
      expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toContain("planner");
      expect(state.pinnedAgentIdsByWorkspace[workspaceKey] ?? []).not.toContain("planner");
      const focusedId = findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId;
      if (otherId) expect(focusedId).toBe(otherId);
      else if (sourceId)
        expect(tabs.find((tab) => tab.tabId === focusedId)?.target).toEqual({
          kind: "agent",
          agentId: "executor",
        });
      if (sourceId && !targetExists)
        expect(tabs.find((tab) => tab.tabId === sourceId)?.target).toEqual({
          kind: "agent",
          agentId: "executor",
        });
      expect(state.layoutByWorkspace["host:visible-workspace"]).toEqual(visibleBefore);
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it("keeps tabs on contribution failure and replaces them on retry", async () => {
    const store = useWorkspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: "host:workspace",
      target: { kind: "agent", agentId: "planner" },
      intent: "new",
    });
    const before = structuredClone(useWorkspaceLayoutStore.getState().layoutByWorkspace);
    const onPress = vi
      .fn()
      .mockRejectedValueOnce(new Error("Disconnected"))
      .mockImplementation(async (context) =>
        context.navigation.replaceAgent({ agentId: "executor" }),
      );
    plugins.mockReturnValue([{ ...plugin, planActions: [{ id: "handoff", onPress }] }]);
    const actual = await vi.importActual<typeof import("@/plugins/plan-actions/contribution")>(
      "@/plugins/plan-actions/contribution",
    );
    run.mockImplementation(actual.runPlanContribution);
    await expect(handoffWidgetPlan(input)).rejects.toThrow("Disconnected");
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace).toEqual(before);
    await handoffWidgetPlan(input);
    expect(
      collectAllTabs(useWorkspaceLayoutStore.getState().layoutByWorkspace["host:workspace"].root)
        .filter((tab) => tab.target.kind === "agent")
        .map((tab) => tab.target),
    ).toEqual([{ kind: "agent", agentId: "executor" }]);
  });

  it("removes source occurrences from multiple panes without changing unrelated selection", async () => {
    const store = useWorkspaceLayoutStore.getState();
    const workspaceKey = "host:workspace";
    const sourceId = store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "planner" },
      intent: "new",
    })!;
    const paneId = store.ensureSidePane(workspaceKey, { focus: false })!;
    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "planner" },
      intent: "new",
      placement: { mode: "pane", paneId },
    });
    const otherId = store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "other" },
      intent: "new",
      placement: { mode: "pane", paneId: "main" },
    })!;
    run.mockImplementation(async ({ navigation }) =>
      navigation.replaceAgent("planner", "executor"),
    );
    await handoffWidgetPlan(input);
    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(
      collectAllTabs(layout.root).filter(
        (tab) => tab.target.kind === "agent" && tab.target.agentId === "planner",
      ),
    ).toHaveLength(0);
    expect(collectAllTabs(layout.root).find((tab) => tab.tabId === sourceId)?.target).toEqual({
      kind: "agent",
      agentId: "executor",
    });
    expect(findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId).toBe(otherId);
  });

  it("retains foreground navigation for in-app handoff", () => {
    createPluginNavigation({ serverId: "host", workspaceId: "workspace" }).replaceAgent!(
      "planner",
      "executor",
    );
    expect(navigate).toHaveBeenCalledWith({
      serverId: "host",
      workspaceId: "workspace",
      agentId: "executor",
    });
  });

  it("renews progress beyond thirty seconds, stops signaling, and allows a failed retry", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    run.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = handoffWidgetPlan(input);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(progress).toHaveBeenCalledTimes(3);
    finish();
    await pending;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(progress).toHaveBeenCalledTimes(3);
    run.mockRejectedValueOnce(new Error("Disconnected"));
    await expect(handoffWidgetPlan(input)).rejects.toThrow("Disconnected");
    await expect(handoffWidgetPlan(input)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(3);
  });
});
