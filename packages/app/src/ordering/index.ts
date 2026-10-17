import { applyTabOrder, tabKey } from "./layout";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  applySharedOrder,
  ordersEqual,
  type OrderRecord,
  type OrderScope,
} from "@getpaseo/protocol/ordering";
import { buildWorkspaceStructureProjects } from "@/projects/workspace-structure";
import { useSessionStore } from "@/stores/session-store";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { isOrderGesture, observeOrderIntents, reportOrderError, type OrderIntent } from "./intents";
import { createOrderMove } from "./move";
import { collectAllTabs, collectAllPanes } from "@/stores/workspace-layout-actions";
import {
  OrderReplica,
  OrderConflictError,
  OrderItemsRemovedError,
  type OrderMembership,
} from "./replica";

function projects() {
  return buildWorkspaceStructureProjects({
    sessions: Object.entries(useSessionStore.getState().sessions).map(([serverId, session]) => ({
      serverId,
      projects: session.projects.values(),
      workspaces: session.workspaces.values(),
    })),
  });
}

type OrderingClient = Pick<
  DaemonClient,
  "setOrder" | "observeOrders" | "setOrderTargets" | "getLastServerInfoMessage"
>;

interface HostOrdering {
  client: OrderingClient;
  canWrite: boolean;
  directoryReady: boolean;
  replica: OrderReplica;
  release: () => void;
  ready: Promise<void>;
  deviceRevision: number | null;
  inventory: string | null;
  syncing: Promise<void> | null;
}

export interface ConnectOrderingInput {
  serverId: string;
  client: OrderingClient;
  supported: boolean;
  directoryReady: boolean;
}
class SharedOrderingController {
  private readonly replicas = new Map<string, OrderReplica>();
  constructor() {
    observeOrderIntents((intent) => this.publish(intent));
  }
  private readonly hosts = new Map<string, HostOrdering>();
  private applying = false;
  private readonly unsupported = new Set<string>();
  private readonly readOnly = new Set<string>();

  private observing = false;

  private observeStores(): void {
    if (this.observing) return;
    this.observing = true;
    useSidebarOrderStore.subscribe((state, previous) => {
      if (
        state.workspaceOrderByProject !== previous.workspaceOrderByProject ||
        state.pinnedWorkspaceOrder !== previous.pinnedWorkspaceOrder
      )
        this.reapply();
    });
    useWorkspaceLayoutStore.subscribe((state, previous) => {
      if (
        state.layoutByWorkspace !== previous.layoutByWorkspace ||
        state.sheetsByWorkspace !== previous.sheetsByWorkspace
      ) {
        this.reapply();
        this.syncInventories();
      }
    });
    useSessionStore.subscribe((state, previous) => {
      if (
        [...this.hosts.keys()].some(
          (id) =>
            state.sessions[id]?.workspaces !== previous.sessions[id]?.workspaces ||
            state.sessions[id]?.projects !== previous.sessions[id]?.projects ||
            state.sessions[id]?.hasHydratedWorkspaces !==
              previous.sessions[id]?.hasHydratedWorkspaces,
        )
      ) {
        this.reapply();
        this.syncInventories();
        for (const host of this.hosts.values()) host.replica.retry();
      }
    });
    useWorkspaceLayoutStore.persist.onFinishHydration(() => this.syncInventories());
  }

  async connect(input: ConnectOrderingInput): Promise<void> {
    const existing = this.hosts.get(input.serverId);
    if (existing?.client === input.client) {
      if (input.directoryReady) this.directoryReady(input.serverId);
      return existing.ready;
    }
    this.disconnect(input.serverId);
    this.observeStores();
    // COMPAT(sharedOrderingTargets): added in v0.11.x, remove gate after 2027-04-17 once daemon floor supports target inventories.
    if (!input.supported) {
      this.unsupported.add(input.serverId);
      return;
    }
    const permissions = input.client.getLastServerInfoMessage()?.permissions;
    const canWrite = permissions?.includes("workspace.manage") === true;
    if (canWrite) this.readOnly.delete(input.serverId);
    else this.readOnly.add(input.serverId);
    const subscription = input.client.observeOrders();
    const replica = this.replica(input.serverId);
    // A confirmed read-only connection cannot publish its offline gestures. Unknown permissions retain them.
    if (permissions !== undefined && !canWrite && replica.cancelPending())
      reportOrderError({ kind: "permissionLost" });
    const host: HostOrdering = {
      client: input.client,
      canWrite,
      directoryReady: input.directoryReady,
      replica,
      release: () => {
        replica.pause();
        void subscription.release().catch(() => undefined);
      },
      ready: subscription.ready.then(() => undefined),
      deviceRevision: null,
      inventory: null,
      syncing: null,
    };
    this.hosts.set(input.serverId, host);
    subscription.subscribe({
      snapshot: (snapshot) => {
        if (this.hosts.get(input.serverId) !== host) return;
        if (snapshot.deviceRevision === undefined)
          throw new Error("Ordering target revision is missing");
        host.deviceRevision = snapshot.deviceRevision;
        replica.snapshot(snapshot.records);
        this.syncInventories();
      },
      update: (message) => {
        if (this.hosts.get(input.serverId) === host && message.type === "ui.order.update")
          replica.receive(message.payload.scope, message.payload.record);
      },
      error: (error) => {
        if (this.hosts.get(input.serverId) !== host) return;
        this.disconnect(input.serverId);
        console.error("[SharedOrdering] Subscription failed", { serverId: input.serverId, error });
      },
    });
    await host.ready;
  }

  directoryReady(serverId: string): void {
    const host = this.hosts.get(serverId);
    if (!host) return;
    host.directoryReady = true;
    host.replica.retry();
    this.syncInventories();
  }

  disconnect(serverId: string): void {
    this.hosts.get(serverId)?.release();
    this.hosts.delete(serverId);
    this.unsupported.delete(serverId);
  }

  private reapply(): void {
    if (this.applying || isOrderGesture()) return;
    for (const host of this.hosts.values()) host.replica.reapply();
  }

  private apply(serverId: string, records: readonly OrderRecord[]): void {
    if (this.applying || isOrderGesture()) return;
    this.applying = true;
    try {
      const structure = projects();
      for (const record of records) {
        const scope = record.scope;
        if (scope.kind === "tabs") {
          const workspaceKey = `${serverId}:${scope.workspaceId}`;
          const store = useWorkspaceLayoutStore.getState();
          const layout = store.layoutByWorkspace[workspaceKey];
          if (!layout) continue;
          const next = applyTabOrder(layout, record.order);
          if (next !== layout)
            useWorkspaceLayoutStore.setState({
              layoutByWorkspace: { ...store.layoutByWorkspace, [workspaceKey]: next },
            });
          continue;
        }
        const store = useSidebarOrderStore.getState();
        const shared = record.order.map((id) => `${serverId}:${id}`);
        if (scope.kind === "pinned") {
          const available = [
            ...(useSessionStore.getState().sessions[serverId]?.workspaces.values() ?? []),
          ]
            .filter((workspace) => workspace.pinnedAt)
            .sort((left, right) => right.pinnedAt!.localeCompare(left.pinnedAt!))
            .map((workspace) => `${serverId}:${workspace.id}`);
          const present = new Set(store.pinnedWorkspaceOrder);
          const complete = [
            ...store.pinnedWorkspaceOrder,
            ...available.filter((key) => !present.has(key)),
          ];
          const next = applySharedOrder(complete, shared);
          if (!ordersEqual(next, store.pinnedWorkspaceOrder))
            store.setPinnedWorkspaceOrder({ keys: next });
          continue;
        }
        const project = structure.find((candidate) =>
          candidate.hosts.some(
            (host) => host.serverId === serverId && host.projectId === scope.projectId,
          ),
        );
        if (!project) continue;
        const current = store.getWorkspaceOrder(project.viewKey);
        const currentSet = new Set(current);
        const complete = [
          ...current,
          ...project.workspaceKeys.filter((key) => !currentSet.has(key)),
        ];
        const next = applySharedOrder(complete, shared);
        if (!ordersEqual(current, next))
          store.setWorkspaceOrder({ projectViewKey: project.viewKey, keys: next });
      }
    } finally {
      this.applying = false;
    }
  }

  private replica(serverId: string): OrderReplica {
    let replica = this.replicas.get(serverId);
    if (replica) return replica;
    replica = new OrderReplica({
      membership: (scope) => this.membership(serverId, scope),
      port: {
        setOrder: async (input) => {
          const host = this.hosts.get(serverId);
          if (!host) throw new Error("Ordering host is offline");
          await this.syncInventory(serverId, host);
          if (this.hosts.get(serverId) !== host) throw new Error("Ordering connection changed");
          return host.client.setOrder(input);
        },
      },
      apply: (records) => this.apply(serverId, records),
      failed: (error) => {
        if (error instanceof OrderItemsRemovedError) {
          reportOrderError({ kind: "removed" });
          console.warn("[SharedOrdering] Cancelled unavailable moves or anchors", {
            serverId,
            keys: error.keys,
          });
          return;
        }
        reportOrderError({ kind: error instanceof OrderConflictError ? "conflict" : "failed" });
        console.error("[SharedOrdering] Order remains pending", { serverId, error });
      },
    });
    this.replicas.set(serverId, replica);
    return replica;
  }

  private membership(serverId: string, scope: OrderScope): OrderMembership {
    const host = this.hosts.get(serverId);
    if (!host?.canWrite || !host.directoryReady || this.inventory(serverId) === null)
      return "pending";
    const session = useSessionStore.getState().sessions[serverId]!;
    if (scope.kind === "tabs") return session.workspaces.has(scope.workspaceId) ? "all" : new Set();
    return new Set(
      [...session.workspaces.values()]
        .filter((workspace) =>
          scope.kind === "pinned"
            ? Boolean(workspace.pinnedAt)
            : workspace.projectId === scope.projectId,
        )
        .map((workspace) => workspace.id),
    );
  }

  private inventory(serverId: string) {
    const session = useSessionStore.getState().sessions[serverId];
    const store = useWorkspaceLayoutStore.getState();
    if (!useWorkspaceLayoutStore.persist.hasHydrated() || !session?.hasHydratedWorkspaces)
      return null;
    return [...session.workspaces.values()].flatMap((workspace) => {
      const workspaceKey = `${serverId}:${workspace.id}`;
      const layout = store.layoutByWorkspace[workspaceKey];
      const sheets = store.sheetsByWorkspace[workspaceKey] ?? [];
      const tabs = [
        ...(layout ? collectAllTabs(layout.root) : []),
        ...sheets.map((sheet) => sheet.tab),
      ];
      const targets = [
        ...new Set(tabs.map(tabKey).filter((key) => !key.startsWith("local:"))),
      ].sort();
      return targets.length ? [{ workspaceId: workspace.id, targets }] : [];
    });
  }
  private syncInventories(): void {
    for (const [serverId, host] of this.hosts) {
      if (
        !host.canWrite ||
        !host.directoryReady ||
        host.deviceRevision === null ||
        this.inventory(serverId) === null
      )
        continue;
      void this.syncInventory(serverId, host).catch((error) => {
        console.error("[SharedOrdering] Target inventory remains pending", { serverId, error });
        reportOrderError({ kind: "failed" });
      });
    }
  }
  private async syncInventory(serverId: string, host: HostOrdering): Promise<void> {
    if (host.syncing) {
      await host.syncing;
      return this.syncInventory(serverId, host);
    }
    const workspaces = this.inventory(serverId);
    if (workspaces === null || host.deviceRevision === null)
      throw new Error("Ordering inventory is not ready");
    const encoded = JSON.stringify(workspaces);
    if (encoded === host.inventory) return;
    host.syncing = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (this.hosts.get(serverId) !== host) throw new Error("Ordering connection changed");
        const result = await host.client.setOrderTargets({
          expectedRevision: host.deviceRevision!,
          workspaces,
        });
        host.deviceRevision = result.revision;
        if (result.accepted) {
          host.inventory = encoded;
          host.replica.retry();
          return;
        }
      }
      throw new OrderConflictError();
    })();
    try {
      await host.syncing;
    } finally {
      host.syncing = null;
    }
    // Closing the last target during an in-flight publication must send the new empty inventory too.
    return this.syncInventory(serverId, host);
  }

  private publishTabs(intent: Extract<OrderIntent, { kind: "tabs" }>): void {
    const sessions = useSessionStore.getState().sessions;
    for (const [serverId, session] of Object.entries(sessions)) {
      const workspace = [...session.workspaces.values()].find(
        (w) => `${serverId}:${w.id}` === intent.workspaceKey,
      );
      if (!workspace) continue;
      if (this.readOnly.has(serverId)) {
        this.reapply();
        return;
      }
      if (this.unsupported.has(serverId)) {
        reportOrderError({ kind: "unsupported" });
        return;
      }
      const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[intent.workspaceKey];
      if (!layout) return;
      const pane = collectAllPanes(layout.root).find((p) => p.id === intent.paneId);
      if (!pane) return;
      const tabs = collectAllTabs({ kind: "pane", pane });
      const moved = tabs.find((tab) => tab.tabId === intent.movedTabId);
      if (!moved || tabKey(moved).startsWith("local:")) return;
      if (!this.hosts.has(serverId) || this.hosts.get(serverId)!.deviceRevision === null)
        reportOrderError({ kind: "failed" });
      this.replica(serverId).reorder({
        scope: { kind: "tabs", workspaceId: workspace.id },
        move: createOrderMove({
          moved: tabKey(moved),
          order: tabs.map(tabKey).filter((key) => !key.startsWith("local:")),
        }),
      });
    }
  }
  private publish(intent: OrderIntent): void {
    if (intent.kind === "tabs") return this.publishTabs(intent);
    const sessions = useSessionStore.getState().sessions;
    for (const [serverId, session] of Object.entries(sessions)) {
      const moved = [...session.workspaces.values()].find(
        (w) => `${serverId}:${w.id}` === intent.moved,
      );
      if (!moved) continue;
      if (this.readOnly.has(serverId)) {
        this.reapply();
        return;
      }
      const projectId = moved.projectId;
      const project =
        intent.kind === "workspaces"
          ? projects().find((p) => p.viewKey === intent.projectViewKey)
          : null;
      if (
        intent.kind === "workspaces" &&
        !project?.hosts.some((h) => h.serverId === serverId && h.projectId === projectId)
      )
        return;
      const ids = new Map(
        [...session.workspaces.values()]
          .filter((w) =>
            intent.kind === "pinned" ? Boolean(w.pinnedAt) : w.projectId === projectId,
          )
          .map((w) => [`${serverId}:${w.id}`, w.id]),
      );
      const projectOrder = (keys: string[]) =>
        keys.flatMap((key) => {
          const id = ids.get(key);
          return id ? [id] : [];
        });
      const before = projectOrder(intent.before);
      const after = projectOrder(intent.after);
      if (ordersEqual(before, after)) return;
      if (this.unsupported.has(serverId)) {
        reportOrderError({ kind: "unsupported" });
        return;
      }
      const scope: OrderScope =
        intent.kind === "pinned" ? { kind: "pinned" } : { kind: "workspaces", projectId };
      if (!this.hosts.has(serverId) || this.hosts.get(serverId)!.deviceRevision === null)
        reportOrderError({ kind: "failed" });
      this.replica(serverId).reorder({
        scope,
        move: createOrderMove({ moved: moved.id, order: after }),
      });
      return;
    }
  }
}
export const sharedOrdering = new SharedOrderingController();
