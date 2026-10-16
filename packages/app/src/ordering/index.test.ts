import type { OrderRecord } from "@getpaseo/protocol/ordering";
import {
  collectAllPanes,
  collectAllTabs,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { observeOrderErrors, type OrderError } from "./intents";
import { afterEach, expect, test } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { subscriptionFixture } from "@/runtime/subscription-fixture";
import {
  normalizeProjectDescriptor,
  normalizeWorkspaceDescriptor,
  useSessionStore,
} from "@/stores/session-store";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { sharedOrdering } from "./index";

const host = "order-host";
type Client = Pick<DaemonClient, "setOrder" | "observeOrders" | "setOrderTargets">;
class FakeClient implements Client {
  records: OrderRecord[] | null = null;
  readonly calls: Parameters<Client["setOrder"]>[0][] = [];
  observeOrders() {
    return subscriptionFixture(
      Promise.resolve({
        requestId: "r",
        deviceRevision: 0,
        records: this.records ?? [
          {
            scope: { kind: "workspaces" as const, projectId: "p" },
            revision: 1,
            order: ["b", "a"],
          },
          { scope: { kind: "pinned" as const }, revision: 1, order: ["a", "b"] },
        ],
      }),
      () => () => {},
    );
  }
  async setOrderTargets() {
    return { requestId: "targets", accepted: true, revision: 1 };
  }
  async setOrder(input: Parameters<Client["setOrder"]>[0]) {
    this.calls.push(input);
    return {
      requestId: "set",
      accepted: true,
      record: { scope: input.scope, revision: input.expectedRevision + 1, order: input.order },
    };
  }
}
afterEach(() => {
  sharedOrdering.disconnect(host);
  sharedOrdering.disconnect("other-order-host");
  useSessionStore.getState().clearSession("other-order-host");
  useWorkspaceLayoutStore.setState({ layoutByWorkspace: {}, sheetsByWorkspace: {} });
  useSessionStore.getState().clearSession(host);
  useSidebarOrderStore.setState({ workspaceOrderByProject: {}, pinnedWorkspaceOrder: [] });
});
function populate(serverId = host) {
  const store = useSessionStore.getState();
  store.setProjects(serverId, [
    normalizeProjectDescriptor({
      projectId: "p",
      projectKey: "project-key",
      projectDisplayName: "Project",
      projectRootPath: "/repo",
      projectKind: "git",
    }),
  ]);
  store.setWorkspaces(
    serverId,
    new Map(
      ["a", "b"].map((id) => [
        id,
        normalizeWorkspaceDescriptor({
          id,
          projectId: "p",
          projectDisplayName: "Project",
          projectRootPath: "/repo",
          workspaceDirectory: `/repo/${id}`,
          projectKind: "git",
          workspaceKind: "local_checkout",
          name: id,
          status: "done",
          statusEnteredAt: null,
          activityAt: null,
          archivingAt: null,
          diffStat: null,
          scripts: [],
          pinnedAt: id === "a" ? "2026-01-01" : "2026-01-02",
        }),
      ]),
    ),
  );
}
test("a cold install applies shared workspace and pinned order without publishing an empty cache", async () => {
  const client = new FakeClient();
  useSessionStore.getState().initializeSession(host, null);
  await sharedOrdering.connect({ serverId: host, client, supported: true });
  populate();
  useSessionStore.getState().setHasHydratedWorkspaces(host, true);
  expect(useSidebarOrderStore.getState().getWorkspaceOrder("project-key")).toEqual([
    `${host}:b`,
    `${host}:a`,
  ]);
  expect(useSidebarOrderStore.getState().pinnedWorkspaceOrder).toEqual([`${host}:a`, `${host}:b`]);
  expect(client.calls).toEqual([]);
  useSidebarOrderStore.getState().setWorkspaceOrder({
    projectViewKey: "project-key",
    keys: [`${host}:a`, `${host}:b`],
    gesture: {
      userInitiated: true,
      movedKey: `${host}:a`,
    },
  });
  await expect
    .poll(() => client.calls)
    .toEqual([
      { scope: { kind: "workspaces", projectId: "p" }, expectedRevision: 1, order: ["a", "b"] },
    ]);
});
test("an unsupported host receives no new ordering RPC", async () => {
  const client = new FakeClient();
  useSessionStore.getState().initializeSession(host, null);
  populate();
  useSessionStore.getState().setHasHydratedWorkspaces(host, true);
  const errors: OrderError[] = [];
  const release = observeOrderErrors((error) => errors.push(error));
  await sharedOrdering.connect({ serverId: host, client, supported: false });
  useSidebarOrderStore.getState().setWorkspaceOrder({
    projectViewKey: "project-key",
    keys: [`${host}:b`, `${host}:a`],
    gesture: {
      userInitiated: true,
      movedKey: `${host}:a`,
    },
  });
  expect(client.calls).toEqual([]);
  expect(errors).toEqual([{ kind: "unsupported" }]);
  release();
});

test("a gesture before connect survives the first shared snapshot", async () => {
  const client = new FakeClient();
  useSessionStore.getState().initializeSession(host, null);
  populate();
  useSessionStore.getState().setHasHydratedWorkspaces(host, true);
  useSidebarOrderStore.getState().setWorkspaceOrder({
    projectViewKey: "project-key",
    keys: [`${host}:a`, `${host}:b`],
    gesture: {
      userInitiated: true,
      movedKey: `${host}:a`,
    },
  });
  await sharedOrdering.connect({ serverId: host, client, supported: true });
  await expect
    .poll(() => client.calls)
    .toEqual([
      { scope: { kind: "workspaces", projectId: "p" }, expectedRevision: 1, order: ["a", "b"] },
    ]);
});
test("pinned gestures publish only the moved host; cross-host interleaving stays local", async () => {
  const otherHost = "other-order-host";
  const first = new FakeClient();
  const second = new FakeClient();
  for (const serverId of [host, otherHost]) {
    useSessionStore.getState().initializeSession(serverId, null);
    populate(serverId);
    useSessionStore.getState().setHasHydratedWorkspaces(serverId, true);
  }
  await sharedOrdering.connect({ serverId: host, client: first, supported: true });
  await sharedOrdering.connect({ serverId: otherHost, client: second, supported: true });
  const store = useSidebarOrderStore.getState();
  store.setPinnedWorkspaceOrder({
    keys: [`${host}:a`, `${host}:b`, `${otherHost}:a`, `${otherHost}:b`],
  });
  store.setPinnedWorkspaceOrder({
    keys: [`${host}:b`, `${host}:a`, `${otherHost}:a`, `${otherHost}:b`],
    gesture: {
      userInitiated: true,
      movedKey: `${host}:b`,
    },
  });
  await expect.poll(() => first.calls.length).toBe(1);
  expect(first.calls[0]!.order).toEqual(["b", "a"]);
  expect(second.calls).toEqual([]);
  store.setPinnedWorkspaceOrder({
    keys: [`${host}:b`, `${otherHost}:a`, `${host}:a`, `${otherHost}:b`],
    gesture: {
      userInitiated: true,
      movedKey: `${host}:a`,
    },
  });
  expect(first.calls).toHaveLength(1);
  expect(second.calls).toEqual([]);
});
test("a split pane publishes the real moved target and never flattens unrelated panes", async () => {
  const client = new FakeClient();
  client.records = [
    {
      scope: { kind: "tabs", workspaceId: "a" },
      revision: 4,
      order: ["agent_a", "agent_b", "agent_c", "agent_d"],
    },
  ];
  useSessionStore.getState().initializeSession(host, null);
  populate();
  useSessionStore.getState().setHasHydratedWorkspaces(host, true);
  const workspaceKey = `${host}:a`;
  const store = useWorkspaceLayoutStore.getState();
  const ids = ["a", "b", "c", "d"].map(
    (agentId) =>
      store.openTab({ workspaceKey, target: { kind: "agent", agentId }, intent: "new" })!,
  );
  const initial = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]!;
  const main = collectAllPanes(initial.root).find((pane) => pane.tabIds.includes(ids[0]!))!;
  const otherPane = store.splitPane(workspaceKey, {
    tabId: ids[1]!,
    targetPaneId: main.id,
    position: "right",
  })!;
  store.moveTabToPane(workspaceKey, ids[3]!, otherPane);
  await sharedOrdering.connect({ serverId: host, client, supported: true });
  store.reorderTabsInPane({
    workspaceKey,
    paneId: main.id,
    tabIds: [ids[2]!, ids[0]!],
    movedTabId: ids[2]!,
  });
  await expect
    .poll(() => client.calls)
    .toEqual([
      {
        scope: { kind: "tabs", workspaceId: "a" },
        expectedRevision: 4,
        order: ["agent_c", "agent_a", "agent_b", "agent_d"],
      },
    ]);
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]!;
  const pane = collectAllPanes(layout.root).find((candidate) => candidate.id === otherPane)!;
  expect(collectAllTabs({ kind: "pane", pane }).map((tab) => tab.target)).toEqual([
    { kind: "agent", agentId: "b" },
    { kind: "agent", agentId: "d" },
  ]);
});
