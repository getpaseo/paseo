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
import { OrderReplica, OrderConflictError } from "./replica";

/** Retain entries this device cannot render; reorder only its observed subset. */
function mergeIntent(shared: readonly string[], local: readonly string[]): string[] {
  const existing = new Set(shared);
  return [...applySharedOrder(shared, local), ...local.filter((key) => !existing.has(key))];
}

function projects() {
  return buildWorkspaceStructureProjects({
    sessions: Object.entries(useSessionStore.getState().sessions).map(([serverId, session]) => ({
      serverId,
      projects: session.projects.values(),
      workspaces: session.workspaces.values(),
    })),
  });
}

type OrderingClient = Pick<DaemonClient, "setOrder" | "observeOrders">;

interface HostOrdering {
  client: OrderingClient;
  replica: OrderReplica;
  release: () => void;
  ready: Promise<void>;
}

class SharedOrderingController {
  private readonly hosts = new Map<string, HostOrdering>();
  private applying = false;
  private readonly unsupported = new Set<string>();

  private observing = false;

  private observeStores(): void {
    if (this.observing) return;
    this.observing = true;
    observeOrderIntents((intent) => this.publish(intent));
    useSidebarOrderStore.subscribe((state, previous) => {
      if (
        state.workspaceOrderByProject !== previous.workspaceOrderByProject ||
        state.pinnedWorkspaceOrder !== previous.pinnedWorkspaceOrder
      )
        this.reapply();
    });
    useWorkspaceLayoutStore.subscribe((state, previous) => {
      if (state.layoutByWorkspace !== previous.layoutByWorkspace) this.reapply();
    });
    useSessionStore.subscribe((state, previous) => {
      if (
        [...this.hosts.keys()].some(
          (id) =>
            state.sessions[id]?.workspaces !== previous.sessions[id]?.workspaces ||
            state.sessions[id]?.projects !== previous.sessions[id]?.projects,
        )
      )
        this.reapply();
    });
  }

  async connect(input: {
    serverId: string;
    client: OrderingClient;
    supported: boolean;
  }): Promise<void> {
    const existing = this.hosts.get(input.serverId);
    if (existing?.client === input.client) return existing.ready;
    this.disconnect(input.serverId);
    this.observeStores();
    // COMPAT(sharedOrdering): added in v0.11.x, remove gate after 2027-04-12 once daemon floor supports sharedOrdering.
    if (!input.supported) {
      this.unsupported.add(input.serverId);
      return;
    }
    const subscription = input.client.observeOrders();
    const replica = new OrderReplica(
      input.client,
      (records) => this.apply(input.serverId, records),
      (error) => {
        if (error instanceof OrderConflictError) {
          reportOrderError({ kind: "conflict" });
          return;
        }
        reportOrderError({
          kind: "failed",
          detail: error instanceof Error ? error.message : undefined,
        });
        console.error("[SharedOrdering] Order update failed", { serverId: input.serverId, error });
      },
    );
    const host: HostOrdering = {
      client: input.client,
      replica,
      release: () => {
        replica.dispose();
        void subscription.release().catch(() => undefined);
      },
      ready: subscription.ready.then(() => undefined),
    };
    this.hosts.set(input.serverId, host);
    subscription.subscribe({
      snapshot: (snapshot) => {
        if (this.hosts.get(input.serverId) === host) replica.snapshot(snapshot.records);
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
          if (!ordersEqual(next, store.pinnedWorkspaceOrder)) store.setPinnedWorkspaceOrder(next);
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
        if (!ordersEqual(current, next)) store.setWorkspaceOrder(project.viewKey, next);
      }
    } finally {
      this.applying = false;
    }
  }

  private affectsUnsupportedHost(intent: OrderIntent): boolean {
    if (intent.kind === "pinned") return this.unsupported.size > 0;
    if (intent.kind === "tabs")
      return [...this.unsupported].some((serverId) =>
        [...(useSessionStore.getState().sessions[serverId]?.workspaces.values() ?? [])].some(
          (workspace) => `${serverId}:${workspace.id}` === intent.workspaceKey,
        ),
      );
    return (
      projects()
        .find((project) => project.viewKey === intent.projectViewKey)
        ?.hosts.some((host) => this.unsupported.has(host.serverId)) === true
    );
  }

  private publish(intent: OrderIntent): void {
    if (this.affectsUnsupportedHost(intent)) reportOrderError({ kind: "unsupported" });
    if (intent.kind === "tabs") {
      for (const [serverId, host] of this.hosts) {
        const session = useSessionStore.getState().sessions[serverId];
        const workspace = [...(session?.workspaces.values() ?? [])].find(
          (candidate) => `${serverId}:${candidate.id}` === intent.workspaceKey,
        );
        if (!workspace) continue;
        const scope: OrderScope = { kind: "tabs", workspaceId: workspace.id };
        const tabs = useWorkspaceLayoutStore.getState().getWorkspaceTabs(intent.workspaceKey);
        const keys = [
          ...new Set(
            tabs
              .filter(
                (tab) =>
                  tab.target.kind !== "new_tab" &&
                  tab.target.kind !== "draft" &&
                  tab.target.kind !== "commit_diff",
              )
              .map(tabKey),
          ),
        ];
        host.replica.reorder(scope, mergeIntent(host.replica.order(scope), keys));
      }
      return;
    }
    const structure = projects();
    for (const [serverId, host] of this.hosts) {
      const session = useSessionStore.getState().sessions[serverId];
      if (!session) continue;
      const store = useSidebarOrderStore.getState();
      if (intent.kind === "pinned") {
        const scope: OrderScope = { kind: "pinned" };
        const keys = store.pinnedWorkspaceOrder.flatMap((key) => {
          const workspace = [...session.workspaces.values()].find(
            (candidate) => `${serverId}:${candidate.id}` === key && candidate.pinnedAt,
          );
          return workspace ? [workspace.id] : [];
        });
        host.replica.reorder(scope, mergeIntent(host.replica.order(scope), keys));
      } else {
        const project = structure.find((candidate) => candidate.viewKey === intent.projectViewKey);
        for (const placement of project?.hosts ?? []) {
          if (placement.serverId !== serverId) continue;
          const scope: OrderScope = { kind: "workspaces", projectId: placement.projectId };
          const keys = store.getWorkspaceOrder(intent.projectViewKey).flatMap((key) => {
            const workspace = [...session.workspaces.values()].find(
              (candidate) =>
                `${serverId}:${candidate.id}` === key &&
                candidate.projectId === placement.projectId,
            );
            return workspace ? [workspace.id] : [];
          });
          host.replica.reorder(scope, mergeIntent(host.replica.order(scope), keys));
        }
      }
    }
  }
}

export const sharedOrdering = new SharedOrderingController();
