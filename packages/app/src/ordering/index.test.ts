import type { ServerInfoStatusPayload, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { OrderRecord } from "@getpaseo/protocol/ordering";
import {
  collectAllPanes,
  collectAllTabs,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { observeOrderErrors, type OrderError } from "./intents";
import { afterEach, expect, test } from "vitest";
import type { DaemonClient, DaemonEventHandler } from "@getpaseo/client/internal/daemon-client";
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
  private readonly listeners = new Set<DaemonEventHandler>();
  orderGate: Promise<void> = Promise.resolve();
  targetsGate: Promise<void> = Promise.resolve();
  subscribe(listener: DaemonEventHandler) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  changePermissions(permissions: ServerInfoStatusPayload["permissions"]) {
    this.permissions = permissions;
    for (const listener of this.listeners)
      listener({ type: "status", payload: this.getLastServerInfoMessage() });
  }
  records: OrderRecord[] | null = null;
  permissions: ServerInfoStatusPayload["permissions"] = ["workspace.read", "workspace.manage"];
  targetCalls = 0;
  allowedPinned: string[] | null = null;
  receive: (message: SessionOutboundMessage) => void = () => {};
  getLastServerInfoMessage(): ServerInfoStatusPayload {
    return {
      status: "server_info",
      serverId: host,
      hostname: null,
      version: null,
      permissions: this.permissions,
    };
  }
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
      (receive) => {
        this.receive = receive;
        return () => {};
      },
    );
  }
  async setOrderTargets() {
    this.targetCalls++;
    await this.targetsGate;
    return { requestId: "targets", accepted: true, revision: 1 };
  }
  async setOrder(input: Parameters<Client["setOrder"]>[0]) {
    this.calls.push(input);
    await this.orderGate;
    if (
      input.scope.kind === "pinned" &&
      this.allowedPinned &&
      input.order.some((id) => !this.allowedPinned!.includes(id))
    )
      throw new Error("Order contains a workspace outside its scope");
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

test("live permission changes grant ordering without reconnecting", async () => {
  const client = new FakeClient();
  client.permissions = ["workspace.read"];
  useSessionStore.getState().initializeSession(host, null);
  populate();
  useSessionStore.getState().setHasHydratedWorkspaces(host, true);
  await sharedOrdering.connect({ serverId: host, client, supported: true, directoryReady: true });
  expect(client.calls).toEqual([]);
  client.changePermissions(["workspace.read", "workspace.manage"]);
  useSidebarOrderStore.getState().setPinnedWorkspaceOrder({
    keys: [`${host}:b`, `${host}:a`],
    gesture: { userInitiated: true, movedKey: `${host}:b` },
  });
  await expect
    .poll(() => client.calls)
    .toEqual([{ scope: { kind: "pinned" }, expectedRevision: 1, order: ["b", "a"] }]);
});

test("live permission changes cancel pending moves and ignore late acknowledgements", async () => {
  const client = new FakeClient();
  useSessionStore.getState().initializeSession(host, null);
  populate();
  useSessionStore.getState().setHasHydratedWorkspaces(host, true);
  const errors: OrderError[] = [];
  const releaseErrors = observeOrderErrors((error) => errors.push(error));
  let acknowledge = () => {};
  client.orderGate = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  try {
    await sharedOrdering.connect({ serverId: host, client, supported: true, directoryReady: true });
    useSidebarOrderStore.getState().setPinnedWorkspaceOrder({
      keys: [`${host}:b`, `${host}:a`],
      gesture: { userInitiated: true, movedKey: `${host}:b` },
    });
    await expect.poll(() => client.calls.length).toBe(1);
    client.changePermissions(["workspace.read"]);
    expect(errors).toEqual([{ kind: "permissionLost" }]);
    expect(useSidebarOrderStore.getState().pinnedWorkspaceOrder).toEqual([
      `${host}:a`,
      `${host}:b`,
    ]);
    client.receive({
      type: "ui.order.update",
      payload: {
        scope: { kind: "pinned" },
        record: { scope: { kind: "pinned" }, revision: 3, order: ["b", "a"] },
      },
    });
    acknowledge();
    await client.orderGate;
    expect(useSidebarOrderStore.getState().pinnedWorkspaceOrder).toEqual([
      `${host}:b`,
      `${host}:a`,
    ]);
    client.changePermissions(["workspace.read", "workspace.manage"]);
    useSidebarOrderStore.getState().setPinnedWorkspaceOrder({
      keys: [`${host}:a`, `${host}:b`],
      gesture: { userInitiated: true, movedKey: `${host}:a` },
    });
    await expect
      .poll(() => client.calls.at(-1))
      .toEqual({ scope: { kind: "pinned" }, expectedRevision: 3, order: ["a", "b"] });
    expect(client.calls).toHaveLength(2);
  } finally {
    acknowledge();
    releaseErrors();
  }
});

test("live permission changes fence a move waiting for target inventory", async () => {
  const client = new FakeClient();
  let acknowledgeTargets = () => {};
  client.targetsGate = new Promise<void>((resolve) => {
    acknowledgeTargets = resolve;
  });
  useSessionStore.getState().initializeSession(host, null);
  populate();
  useSessionStore.getState().setHasHydratedWorkspaces(host, true);
  const errors: OrderError[] = [];
  const releaseErrors = observeOrderErrors((error) => errors.push(error));
  try {
    await sharedOrdering.connect({ serverId: host, client, supported: true, directoryReady: true });
    const store = useSidebarOrderStore.getState();
    store.setPinnedWorkspaceOrder({
      keys: [`${host}:b`, `${host}:a`],
      gesture: { userInitiated: true, movedKey: `${host}:b` },
    });
    await expect.poll(() => client.targetCalls).toBe(1);
    client.changePermissions(["workspace.read"]);
    client.changePermissions(["workspace.read", "workspace.manage"]);
    store.setPinnedWorkspaceOrder({
      keys: [`${host}:b`, `${host}:a`],
      gesture: { userInitiated: true, movedKey: `${host}:b` },
    });
    acknowledgeTargets();
    await expect
      .poll(() => client.calls)
      .toEqual([{ scope: { kind: "pinned" }, expectedRevision: 1, order: ["b", "a"] }]);
    expect(errors).toEqual([{ kind: "permissionLost" }]);
  } finally {
    acknowledgeTargets();
    releaseErrors();
  }
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
  await sharedOrdering.connect({ serverId: host, client, supported: true, directoryReady: true });
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
  await sharedOrdering.connect({ serverId: host, client, supported: false, directoryReady: true });
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
  await sharedOrdering.connect({ serverId: host, client, supported: true, directoryReady: true });
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
  await sharedOrdering.connect({
    serverId: host,
    client: first,
    supported: true,
    directoryReady: true,
  });
  await sharedOrdering.connect({
    serverId: otherHost,
    client: second,
    supported: true,
    directoryReady: true,
  });
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
  await sharedOrdering.connect({ serverId: host, client, supported: true, directoryReady: true });
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

test("read-only hydration and layout changes never write or toast, while subscribed updates still apply", async () => {
  const client = new FakeClient();
  client.permissions = ["workspace.read"];
  const errors: OrderError[] = [];
  const release = observeOrderErrors((error) => errors.push(error));
  try {
    useSessionStore.getState().initializeSession(host, null);
    await sharedOrdering.connect({ serverId: host, client, supported: true, directoryReady: true });
    populate();
    useSessionStore.getState().setHasHydratedWorkspaces(host, true);
    const workspaceKey = `${host}:a`;
    const store = useWorkspaceLayoutStore.getState();
    const ids = ["a", "b"].map(
      (agentId) =>
        store.openTab({
          workspaceKey,
          target: { kind: "agent", agentId },
          intent: "new",
        })!,
    );
    await Promise.resolve();
    expect(client.targetCalls).toBe(0);
    store.reorderTabs({ workspaceKey, tabIds: ids.toReversed(), movedTabId: ids[1]! });
    await Promise.resolve();
    expect(client.calls).toEqual([]);
    expect(client.targetCalls).toBe(0);
    expect(errors).toEqual([]);
    client.receive({
      type: "ui.order.update",
      payload: {
        scope: { kind: "pinned" },
        record: { scope: { kind: "pinned" }, revision: 2, order: ["b", "a"] },
      },
    });
    expect(useSidebarOrderStore.getState().pinnedWorkspaceOrder).toEqual([
      `${host}:b`,
      `${host}:a`,
    ]);
  } finally {
    release();
  }
});

test("a read-only reconnect cancels offline moves, projects snapshots and updates, and later writes only new gestures", async () => {
  const otherHost = "other-order-host";
  const store = useSidebarOrderStore.getState();
  for (const serverId of [host, otherHost]) {
    useSessionStore.getState().initializeSession(serverId, null);
    populate(serverId);
    useSessionStore.getState().setHasHydratedWorkspaces(serverId, true);
    await sharedOrdering.connect({
      serverId,
      client: new FakeClient(),
      supported: true,
      directoryReady: true,
    });
    sharedOrdering.disconnect(serverId);
    store.setPinnedWorkspaceOrder({
      keys: [
        ...useSidebarOrderStore
          .getState()
          .pinnedWorkspaceOrder.filter((key) => !key.startsWith(`${serverId}:`)),
        `${serverId}:b`,
        `${serverId}:a`,
      ],
      gesture: { userInitiated: true, movedKey: `${serverId}:b` },
    });
  }
  const client = new FakeClient();
  client.permissions = ["workspace.read"];
  const errors: OrderError[] = [];
  const release = observeOrderErrors((error) => errors.push(error));
  const hostOrder = () =>
    useSidebarOrderStore
      .getState()
      .pinnedWorkspaceOrder.filter((key) => key.startsWith(`${host}:`));
  try {
    await sharedOrdering.connect({
      serverId: host,
      client,
      supported: true,
      directoryReady: false,
    });
    expect(hostOrder()).toEqual([`${host}:a`, `${host}:b`]);
    client.receive({
      type: "ui.order.update",
      payload: {
        scope: { kind: "pinned" },
        record: { scope: { kind: "pinned" }, revision: 2, order: ["b", "a"] },
      },
    });
    expect(hostOrder()).toEqual([`${host}:b`, `${host}:a`]);
    client.receive({
      type: "ui.order.update",
      payload: {
        scope: { kind: "pinned" },
        record: { scope: { kind: "pinned" }, revision: 3, order: ["a", "b"] },
      },
    });
    expect(hostOrder()).toEqual([`${host}:a`, `${host}:b`]);
    sharedOrdering.directoryReady(host);
    expect(client.calls).toEqual([]);
    expect(client.targetCalls).toBe(0);
    expect(errors).toEqual([{ kind: "permissionLost" }]);

    const other = new FakeClient();
    await sharedOrdering.connect({
      serverId: otherHost,
      client: other,
      supported: true,
      directoryReady: true,
    });
    await expect
      .poll(() => other.calls)
      .toEqual([{ scope: { kind: "pinned" }, expectedRevision: 1, order: ["b", "a"] }]);
    const writer = new FakeClient();
    writer.records = [{ scope: { kind: "pinned" }, revision: 3, order: ["a", "b"] }];
    await sharedOrdering.connect({
      serverId: host,
      client: writer,
      supported: true,
      directoryReady: true,
    });
    expect(writer.calls).toEqual([]);
    store.setPinnedWorkspaceOrder({
      keys: [`${host}:b`, `${host}:a`, `${otherHost}:b`, `${otherHost}:a`],
      gesture: { userInitiated: true, movedKey: `${host}:b` },
    });
    await expect
      .poll(() => writer.calls)
      .toEqual([{ scope: { kind: "pinned" }, expectedRevision: 3, order: ["b", "a"] }]);
    expect(errors).toEqual([{ kind: "permissionLost" }]);
  } finally {
    release();
  }
});

test("unknown connection permissions retain offline moves until an authoritative writer is ready", async () => {
  useSessionStore.getState().initializeSession(host, null);
  populate();
  useSessionStore.getState().setHasHydratedWorkspaces(host, true);
  await sharedOrdering.connect({
    serverId: host,
    client: new FakeClient(),
    supported: true,
    directoryReady: true,
  });
  sharedOrdering.disconnect(host);
  useSidebarOrderStore.getState().setPinnedWorkspaceOrder({
    keys: [`${host}:b`, `${host}:a`],
    gesture: { userInitiated: true, movedKey: `${host}:b` },
  });
  const errors: OrderError[] = [];
  const release = observeOrderErrors((error) => errors.push(error));
  try {
    const unknown = new FakeClient();
    unknown.permissions = undefined;
    await sharedOrdering.connect({
      serverId: host,
      client: unknown,
      supported: true,
      directoryReady: false,
    });
    expect(unknown.calls).toEqual([]);
    expect(unknown.targetCalls).toBe(0);
    expect(errors).toEqual([]);
    expect(useSidebarOrderStore.getState().pinnedWorkspaceOrder).toEqual([
      `${host}:b`,
      `${host}:a`,
    ]);
    const writer = new FakeClient();
    await sharedOrdering.connect({
      serverId: host,
      client: writer,
      supported: true,
      directoryReady: false,
    });
    expect(writer.calls).toEqual([]);
    expect(writer.targetCalls).toBe(0);
    expect(errors).toEqual([]);
    sharedOrdering.directoryReady(host);
    await expect
      .poll(() => writer.calls)
      .toEqual([{ scope: { kind: "pinned" }, expectedRevision: 1, order: ["b", "a"] }]);
    expect(errors).toEqual([]);
  } finally {
    release();
  }
});

test.each(["unpin", "archive"] as const)(
  "offline pinned %s cancels only impossible moves and later gestures sync",
  async (removal) => {
    useSessionStore.getState().initializeSession(host, null);
    populate();
    const state = useSessionStore.getState();
    const b = state.sessions[host]!.workspaces.get("b")!;
    state.mergeWorkspaces(host, [{ ...b, id: "c" }]);
    state.setHasHydratedWorkspaces(host, true);
    const first = new FakeClient();
    first.records = [{ scope: { kind: "pinned" }, revision: 1, order: ["b", "a", "c"] }];
    await sharedOrdering.connect({
      serverId: host,
      client: first,
      supported: true,
      directoryReady: true,
    });
    sharedOrdering.disconnect(host);
    const store = useSidebarOrderStore.getState();
    store.setPinnedWorkspaceOrder({
      keys: [`${host}:a`, `${host}:b`, `${host}:c`],
      gesture: { userInitiated: true, movedKey: `${host}:a` },
    });
    store.setPinnedWorkspaceOrder({
      keys: [`${host}:a`, `${host}:c`, `${host}:b`],
      gesture: { userInitiated: true, movedKey: `${host}:c` },
    });
    const workspaces = new Map(useSessionStore.getState().sessions[host]!.workspaces);
    if (removal === "archive") workspaces.delete("a");
    else workspaces.set("a", { ...workspaces.get("a")!, pinnedAt: null });
    state.setWorkspaces(host, workspaces);
    const reconnected = new FakeClient();
    reconnected.records = [{ scope: { kind: "pinned" }, revision: 2, order: ["b", "c"] }];
    reconnected.allowedPinned = ["b", "c"];
    const errors: OrderError[] = [];
    const release = observeOrderErrors((error) => errors.push(error));
    try {
      await sharedOrdering.connect({
        serverId: host,
        client: reconnected,
        supported: true,
        directoryReady: true,
      });
      await expect
        .poll(() => reconnected.calls)
        .toEqual([{ scope: { kind: "pinned" }, expectedRevision: 2, order: ["c", "b"] }]);
      store.setPinnedWorkspaceOrder({
        keys: [`${host}:b`, `${host}:c`],
        gesture: { userInitiated: true, movedKey: `${host}:b` },
      });
      await expect.poll(() => reconnected.calls.at(-1)?.order).toEqual(["b", "c"]);
      expect(errors).toEqual([{ kind: "removed" }]);
    } finally {
      release();
    }
  },
);

test("reconnect cache hydration cannot cancel valid offline moves before this connection's directory is authoritative", async () => {
  useSessionStore.getState().initializeSession(host, null);
  populate();
  useSessionStore.getState().setHasHydratedWorkspaces(host, true);
  const original = new FakeClient();
  await sharedOrdering.connect({
    serverId: host,
    client: original,
    supported: true,
    directoryReady: true,
  });
  sharedOrdering.disconnect(host);
  useSidebarOrderStore.getState().setPinnedWorkspaceOrder({
    keys: [`${host}:b`, `${host}:a`],
    gesture: { userInitiated: true, movedKey: `${host}:b` },
  });
  useSessionStore.getState().setWorkspaces(host, new Map());
  useSessionStore.getState().setHasHydratedWorkspaces(host, false);
  const errors: OrderError[] = [];
  const release = observeOrderErrors((error) => errors.push(error));
  try {
    const client = new FakeClient();
    await sharedOrdering.connect({
      serverId: host,
      client,
      supported: true,
      directoryReady: false,
    });
    useSessionStore.getState().setHasHydratedWorkspaces(host, true);
    await Promise.resolve();
    expect(client.calls).toEqual([]);
    expect(client.targetCalls).toBe(0);
    expect(errors).toEqual([]);
    populate();
    sharedOrdering.directoryReady(host);
    await expect
      .poll(() => client.calls)
      .toEqual([{ scope: { kind: "pinned" }, expectedRevision: 1, order: ["b", "a"] }]);
    expect(errors).toEqual([]);
  } finally {
    release();
  }
});

test("an initial tab gesture seeds its complete pane while leaving the other pane untouched", async () => {
  const client = new FakeClient();
  client.records = [];
  useSessionStore.getState().initializeSession(host, null);
  populate();
  useSessionStore.getState().setHasHydratedWorkspaces(host, true);
  const workspaceKey = `${host}:a`;
  const store = useWorkspaceLayoutStore.getState();
  const ids = ["a", "b", "c", "d", "e"].map(
    (agentId) =>
      store.openTab({
        workspaceKey,
        target: { kind: "agent", agentId },
        intent: "new",
      })!,
  );
  const initial = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]!;
  const main = collectAllPanes(initial.root).find((pane) => pane.tabIds.includes(ids[0]!))!;
  const other = store.splitPane(workspaceKey, {
    tabId: ids[1]!,
    targetPaneId: main.id,
    position: "right",
  })!;
  store.moveTabToPane(workspaceKey, ids[3]!, other);
  await sharedOrdering.connect({ serverId: host, client, supported: true, directoryReady: true });
  store.reorderTabsInPane({
    workspaceKey,
    paneId: main.id,
    tabIds: [ids[0]!, ids[4]!, ids[2]!],
    movedTabId: ids[4]!,
  });
  await expect
    .poll(() => client.calls)
    .toEqual([
      {
        scope: { kind: "tabs", workspaceId: "a" },
        expectedRevision: 0,
        order: ["agent_a", "agent_e", "agent_c"],
      },
    ]);
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]!;
  const pane = collectAllPanes(layout.root).find((candidate) => candidate.id === other)!;
  expect(collectAllTabs({ kind: "pane", pane }).map((tab) => tab.target)).toEqual([
    { kind: "agent", agentId: "b" },
    { kind: "agent", agentId: "d" },
  ]);
});

test.each(["working_diff", "pull_request"] as const)(
  "duplicate %s tabs stay independent through local gestures and shared updates",
  async (kind) => {
    const client = new FakeClient();
    client.records = [];
    useSessionStore.getState().initializeSession(host, null);
    populate();
    useSessionStore.getState().setHasHydratedWorkspaces(host, true);
    const workspaceKey = `${host}:a`;
    const store = useWorkspaceLayoutStore.getState();
    const ids = [
      { kind },
      { kind: "agent" as const, agentId: "a" },
      { kind },
      { kind: "agent" as const, agentId: "b" },
    ].map((target) => store.openTab({ workspaceKey, target, intent: "new" })!);
    const paneId = collectAllPanes(
      useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]!.root,
    ).find((pane) => pane.tabIds.includes(ids[0]!))!.id;
    const currentIds = () =>
      collectAllPanes(
        useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]!.root,
      ).find((pane) => pane.id === paneId)!.tabIds;
    await sharedOrdering.connect({ serverId: host, client, supported: true, directoryReady: true });
    const dragged = [ids[0]!, ids[3]!, ids[1]!, ids[2]!];
    store.reorderTabsInPane({ workspaceKey, paneId, tabIds: dragged, movedTabId: ids[3]! });
    await expect.poll(() => client.calls.length).toBe(1);
    expect(client.calls[0]!.order).toEqual(["agent_b", "agent_a"]);
    expect(currentIds()).toEqual(dragged);

    client.receive({
      type: "ui.order.update",
      payload: {
        scope: { kind: "tabs", workspaceId: "a" },
        record: {
          scope: { kind: "tabs", workspaceId: "a" },
          revision: 2,
          order: [kind, "agent_a", "agent_b"],
        },
      },
    });
    expect(currentIds()).toEqual([ids[0], ids[1], ids[3], ids[2]]);
    const duplicateDragged = [ids[2]!, ids[0]!, ids[1]!, ids[3]!];
    store.reorderTabsInPane({
      workspaceKey,
      paneId,
      tabIds: duplicateDragged,
      movedTabId: ids[2]!,
    });
    await Promise.resolve();
    expect(client.calls).toHaveLength(1);
    expect(currentIds()).toEqual(duplicateDragged);
  },
);
