import type { Query, QueryCacheNotifyEvent, QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  ListTerminalsResponse,
  MutableDaemonConfig,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { agentCommandsQueryRoot } from "@/hooks/agent-commands-query";
import { orderCheckoutDiffFiles } from "@/git/diff-order";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import { providersSnapshotQueryKey, providersSnapshotQueryRoot } from "@/data/providers-snapshot";

type ProvidersSnapshotUpdateMessage = Extract<
  SessionOutboundMessage,
  { type: "providers_snapshot_update" }
>;
type CheckoutDiffUpdateMessage = Extract<SessionOutboundMessage, { type: "checkout_diff_update" }>;
type SubscribeCheckoutDiffResponseMessage = Extract<
  SessionOutboundMessage,
  { type: "subscribe_checkout_diff_response" }
>;
type StatusMessage = Extract<SessionOutboundMessage, { type: "status" }>;
type TerminalsChangedMessage = Extract<SessionOutboundMessage, { type: "terminals_changed" }>;
type ServerDataEventType =
  | "providers_snapshot_update"
  | "checkout_diff_update"
  | "subscribe_checkout_diff_response"
  | "status"
  | "terminals_changed";
type CheckoutDiffResponsePayload = SubscribeCheckoutDiffResponseMessage["payload"];
type CheckoutDiffCachePayload = Omit<CheckoutDiffResponsePayload, "subscriptionId">;
type ListTerminalsPayload = ListTerminalsResponse["payload"];

interface CheckoutDiffCompare {
  mode: "uncommitted" | "base";
  baseRef?: string;
  ignoreWhitespace?: boolean;
}

interface CheckoutDiffRoute {
  domain: "checkoutDiff";
  enabled: boolean;
  serverId: string;
  subscriptionId: string;
  cwd: string;
  compare: CheckoutDiffCompare;
}

interface WorkspaceTerminalsRoute {
  domain: "workspaceTerminals";
  enabled: boolean;
  serverId: string;
  cwd: string;
  workspaceId?: string;
}

type ServerDataRoute = CheckoutDiffRoute | WorkspaceTerminalsRoute;

export interface ServerDataQueryMeta extends Record<string, unknown> {
  serverData: ServerDataRoute;
}

export type ProvidersSnapshotUpdate = ProvidersSnapshotUpdateMessage;

interface ServerDataPushClient {
  on<TType extends ServerDataEventType>(
    type: TType,
    handler: (message: Extract<SessionOutboundMessage, { type: TType }>) => void,
  ): () => void;
  subscribeCheckoutDiff(
    cwd: string,
    compare: CheckoutDiffCompare,
    options: { subscriptionId: string; requestId?: string },
  ): Promise<CheckoutDiffResponsePayload>;
  unsubscribeCheckoutDiff(subscriptionId: string): void;
  subscribeTerminals(input: { cwd: string; workspaceId?: string }): void;
  unsubscribeTerminals(input: { cwd: string; workspaceId?: string }): void;
}

interface PushRouterInput {
  client: ServerDataPushClient;
  queryClient: QueryClient;
  serverId: string;
}

interface ActiveServerDataSubscriptions {
  checkoutDiff: Map<string, CheckoutDiffRoute>;
  workspaceTerminals: Map<string, WorkspaceTerminalsRoute>;
}

interface ReconnectRepairPolicy {
  domain: string;
  invalidate(input: { queryClient: QueryClient; serverId: string }): void;
}

const RECONNECT_REPAIR_POLICIES: ReconnectRepairPolicy[] = [
  {
    domain: "providersSnapshot",
    invalidate: ({ queryClient, serverId }) => {
      void queryClient.invalidateQueries({ queryKey: providersSnapshotQueryRoot(serverId) });
    },
  },
  {
    domain: "daemonConfig",
    invalidate: ({ queryClient, serverId }) => {
      void queryClient.invalidateQueries({ queryKey: daemonConfigQueryKey(serverId) });
    },
  },
  {
    domain: "checkoutDiff",
    invalidate: ({ queryClient, serverId }) => {
      void queryClient.invalidateQueries({
        predicate: (query) => isQueryForServer(query.queryKey, "checkoutDiff", serverId),
      });
    },
  },
  {
    domain: "workspaceTerminals",
    invalidate: ({ queryClient, serverId }) => {
      void queryClient.invalidateQueries({
        predicate: (query) => isQueryForServer(query.queryKey, "terminals", serverId),
      });
    },
  },
];
const reconnectSubscriptionRepairsByServerId = new Map<string, Set<() => void>>();

export function checkoutDiffPushRoute(input: {
  enabled: boolean;
  serverId: string;
  subscriptionId: string;
  cwd: string;
  compare: CheckoutDiffCompare;
}): ServerDataQueryMeta {
  return {
    serverData: {
      domain: "checkoutDiff",
      enabled: input.enabled,
      serverId: input.serverId,
      subscriptionId: input.subscriptionId,
      cwd: input.cwd,
      compare: input.compare,
    },
  };
}

export function workspaceTerminalsPushRoute(input: {
  enabled: boolean;
  serverId: string;
  cwd: string;
  workspaceId?: string;
}): ServerDataQueryMeta {
  return {
    serverData: {
      domain: "workspaceTerminals",
      enabled: input.enabled,
      serverId: input.serverId,
      cwd: input.cwd,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    },
  };
}

export function invalidateServerDataQueriesAfterReconnect(input: {
  queryClient: QueryClient;
  serverId: string;
}): void {
  for (const policy of RECONNECT_REPAIR_POLICIES) {
    policy.invalidate(input);
  }
  for (const repairSubscriptions of reconnectSubscriptionRepairsByServerId.get(input.serverId) ??
    []) {
    repairSubscriptions();
  }
}

export function applyProvidersSnapshotUpdate(input: {
  serverId: string;
  queryClient: QueryClient;
  message: ProvidersSnapshotUpdate;
}): void {
  if (input.message.type !== "providers_snapshot_update") {
    return;
  }
  const queryKey = providersSnapshotQueryKey(input.serverId, input.message.payload.cwd);
  input.queryClient.setQueryData(queryKey, {
    entries: input.message.payload.entries,
    generatedAt: input.message.payload.generatedAt,
    requestId: "providers_snapshot_update",
  });
  void input.queryClient.invalidateQueries({
    queryKey: agentCommandsQueryRoot(input.serverId),
    exact: false,
  });
}

export function mountServerDataPushRouter(input: PushRouterInput): () => void {
  const activeCheckoutDiffSubscriptions = new Map<string, CheckoutDiffRoute>();
  const activeTerminalSubscriptions = new Map<string, WorkspaceTerminalsRoute>();
  let disposed = false;

  function reconcileSubscriptions(
    fallbackActive: ActiveServerDataSubscriptions = {
      checkoutDiff: activeCheckoutDiffSubscriptions,
      workspaceTerminals: activeTerminalSubscriptions,
    },
  ): void {
    if (disposed) {
      return;
    }

    const desiredCheckoutDiffSubscriptions = new Map<string, CheckoutDiffRoute>();
    const desiredTerminalSubscriptions = new Map<string, WorkspaceTerminalsRoute>();
    for (const query of input.queryClient.getQueryCache().getAll()) {
      const route = getActiveServerDataRoute(query, input.serverId, {
        checkoutDiff: fallbackActive.checkoutDiff,
        workspaceTerminals: fallbackActive.workspaceTerminals,
      });
      if (!route) {
        continue;
      }
      if (route.domain === "checkoutDiff") {
        desiredCheckoutDiffSubscriptions.set(route.subscriptionId, route);
        continue;
      }
      desiredTerminalSubscriptions.set(workspaceTerminalSubscriptionKey(route), route);
    }

    reconcileCheckoutDiffSubscriptions({
      active: activeCheckoutDiffSubscriptions,
      client: input.client,
      desired: desiredCheckoutDiffSubscriptions,
      serverId: input.serverId,
    });
    reconcileTerminalSubscriptions({
      active: activeTerminalSubscriptions,
      client: input.client,
      desired: desiredTerminalSubscriptions,
    });
  }

  function resetSubscriptionsAfterReconnect(): void {
    const fallbackActive = {
      checkoutDiff: new Map(activeCheckoutDiffSubscriptions),
      workspaceTerminals: new Map(activeTerminalSubscriptions),
    };
    activeCheckoutDiffSubscriptions.clear();
    activeTerminalSubscriptions.clear();
    reconcileSubscriptions(fallbackActive);
  }

  const unsubscribeQueryCache = input.queryClient.getQueryCache().subscribe((event) => {
    if (
      !shouldReconcileSubscriptionsForCacheEvent(event, input.serverId, {
        checkoutDiff: activeCheckoutDiffSubscriptions,
        workspaceTerminals: activeTerminalSubscriptions,
      })
    ) {
      return;
    }
    reconcileSubscriptions();
  });
  const unsubscribeProviders = input.client.on("providers_snapshot_update", (message) => {
    applyProvidersSnapshotUpdate({
      queryClient: input.queryClient,
      serverId: input.serverId,
      message,
    });
  });
  const unsubscribeDaemonConfig = input.client.on("status", (message) => {
    applyDaemonConfigStatus({ queryClient: input.queryClient, serverId: input.serverId, message });
  });
  const unsubscribeCheckoutDiffUpdate = input.client.on("checkout_diff_update", (message) => {
    applyCheckoutDiffUpdate({
      activeCheckoutDiffSubscriptions,
      queryClient: input.queryClient,
      serverId: input.serverId,
      message,
    });
  });
  const unsubscribeCheckoutDiffResponse = input.client.on(
    "subscribe_checkout_diff_response",
    (message) => {
      applyCheckoutDiffSubscribeResponse({
        activeCheckoutDiffSubscriptions,
        queryClient: input.queryClient,
        serverId: input.serverId,
        message,
      });
    },
  );
  const unsubscribeTerminalsChanged = input.client.on("terminals_changed", (message) => {
    applyTerminalsChanged({
      activeCheckoutDiffSubscriptions,
      activeTerminalSubscriptions,
      queryClient: input.queryClient,
      serverId: input.serverId,
      message,
    });
  });
  let reconnectSubscriptionRepairs = reconnectSubscriptionRepairsByServerId.get(input.serverId);
  if (!reconnectSubscriptionRepairs) {
    reconnectSubscriptionRepairs = new Set();
    reconnectSubscriptionRepairsByServerId.set(input.serverId, reconnectSubscriptionRepairs);
  }
  reconnectSubscriptionRepairs.add(resetSubscriptionsAfterReconnect);

  reconcileSubscriptions();

  return () => {
    disposed = true;
    reconnectSubscriptionRepairs.delete(resetSubscriptionsAfterReconnect);
    if (reconnectSubscriptionRepairs.size === 0) {
      reconnectSubscriptionRepairsByServerId.delete(input.serverId);
    }
    unsubscribeQueryCache();
    unsubscribeProviders();
    unsubscribeDaemonConfig();
    unsubscribeCheckoutDiffUpdate();
    unsubscribeCheckoutDiffResponse();
    unsubscribeTerminalsChanged();
    for (const subscriptionId of activeCheckoutDiffSubscriptions.keys()) {
      unsubscribeCheckoutDiff(input.client, subscriptionId);
    }
    activeCheckoutDiffSubscriptions.clear();
    for (const route of activeTerminalSubscriptions.values()) {
      input.client.unsubscribeTerminals(workspaceTerminalSubscriptionInput(route));
    }
    activeTerminalSubscriptions.clear();
  };
}

function reconcileCheckoutDiffSubscriptions(input: {
  active: Map<string, CheckoutDiffRoute>;
  client: ServerDataPushClient;
  desired: Map<string, CheckoutDiffRoute>;
  serverId: string;
}): void {
  for (const [subscriptionId, current] of input.active) {
    const desired = input.desired.get(subscriptionId);
    if (desired && areCheckoutDiffRoutesEqual(current, desired)) {
      continue;
    }
    unsubscribeCheckoutDiff(input.client, subscriptionId);
    input.active.delete(subscriptionId);
  }

  for (const [subscriptionId, desired] of input.desired) {
    if (input.active.has(subscriptionId)) {
      continue;
    }
    input.active.set(subscriptionId, desired);
    void input.client
      .subscribeCheckoutDiff(desired.cwd, desired.compare, {
        subscriptionId,
        requestId: `push-router:${input.serverId}:${subscriptionId}`,
      })
      .catch((error) => {
        if (areCheckoutDiffRoutesEqual(input.active.get(subscriptionId), desired)) {
          input.active.delete(subscriptionId);
        }
        console.error("[server-data] subscribeCheckoutDiff failed", {
          serverId: input.serverId,
          cwd: desired.cwd,
          error,
        });
      });
  }
}

function reconcileTerminalSubscriptions(input: {
  active: Map<string, WorkspaceTerminalsRoute>;
  client: ServerDataPushClient;
  desired: Map<string, WorkspaceTerminalsRoute>;
}): void {
  for (const [key, current] of input.active) {
    const desired = input.desired.get(key);
    if (desired && areWorkspaceTerminalsRoutesEqual(current, desired)) {
      continue;
    }
    input.client.unsubscribeTerminals(workspaceTerminalSubscriptionInput(current));
    input.active.delete(key);
  }

  for (const [key, desired] of input.desired) {
    if (input.active.has(key)) {
      continue;
    }
    input.active.set(key, desired);
    input.client.subscribeTerminals(workspaceTerminalSubscriptionInput(desired));
  }
}

function applyDaemonConfigStatus(input: {
  queryClient: QueryClient;
  serverId: string;
  message: StatusMessage;
}): void {
  const payload = input.message.payload;
  if (!isDaemonConfigChangedPayload(payload)) {
    return;
  }
  input.queryClient.setQueryData<MutableDaemonConfig>(
    daemonConfigQueryKey(input.serverId),
    payload.config,
  );
}

function applyCheckoutDiffUpdate(input: {
  activeCheckoutDiffSubscriptions: Map<string, CheckoutDiffRoute>;
  queryClient: QueryClient;
  serverId: string;
  message: CheckoutDiffUpdateMessage;
}): void {
  setCheckoutDiffPayload({
    activeCheckoutDiffSubscriptions: input.activeCheckoutDiffSubscriptions,
    queryClient: input.queryClient,
    serverId: input.serverId,
    subscriptionId: input.message.payload.subscriptionId,
    payload: {
      cwd: input.message.payload.cwd,
      files: orderCheckoutDiffFiles(input.message.payload.files),
      error: input.message.payload.error,
      requestId: `subscription:${input.message.payload.subscriptionId}`,
    },
  });
}

function applyCheckoutDiffSubscribeResponse(input: {
  activeCheckoutDiffSubscriptions: Map<string, CheckoutDiffRoute>;
  queryClient: QueryClient;
  serverId: string;
  message: SubscribeCheckoutDiffResponseMessage;
}): void {
  setCheckoutDiffPayload({
    activeCheckoutDiffSubscriptions: input.activeCheckoutDiffSubscriptions,
    queryClient: input.queryClient,
    serverId: input.serverId,
    subscriptionId: input.message.payload.subscriptionId,
    payload: {
      cwd: input.message.payload.cwd,
      files: orderCheckoutDiffFiles(input.message.payload.files),
      error: input.message.payload.error,
      requestId: input.message.payload.requestId,
    },
  });
}

function setCheckoutDiffPayload(input: {
  activeCheckoutDiffSubscriptions: Map<string, CheckoutDiffRoute>;
  queryClient: QueryClient;
  serverId: string;
  subscriptionId: string;
  payload: CheckoutDiffCachePayload;
}): void {
  for (const query of input.queryClient.getQueryCache().getAll()) {
    const route =
      getServerDataRoute(query) ??
      getActiveCheckoutDiffRouteForQueryKey({
        active: input.activeCheckoutDiffSubscriptions,
        queryKey: query.queryKey,
        serverId: input.serverId,
      });
    if (
      !route ||
      route.domain !== "checkoutDiff" ||
      route.serverId !== input.serverId ||
      route.subscriptionId !== input.subscriptionId
    ) {
      continue;
    }
    input.queryClient.setQueryData<CheckoutDiffCachePayload>(query.queryKey, input.payload);
  }
}

function applyTerminalsChanged(input: {
  activeCheckoutDiffSubscriptions: Map<string, CheckoutDiffRoute>;
  activeTerminalSubscriptions: Map<string, WorkspaceTerminalsRoute>;
  queryClient: QueryClient;
  serverId: string;
  message: TerminalsChangedMessage;
}): void {
  for (const query of input.queryClient.getQueryCache().getAll()) {
    const route = getActiveServerDataRoute(query, input.serverId, {
      checkoutDiff: input.activeCheckoutDiffSubscriptions,
      workspaceTerminals: input.activeTerminalSubscriptions,
    });
    if (
      !route ||
      route.domain !== "workspaceTerminals" ||
      route.cwd !== input.message.payload.cwd
    ) {
      continue;
    }

    const matchingTerminals = input.message.payload.terminals.filter(
      (terminal) => terminal.workspaceId === route.workspaceId,
    );

    input.queryClient.setQueryData<ListTerminalsPayload>(query.queryKey, (current) => ({
      cwd: input.message.payload.cwd,
      terminals: matchingTerminals,
      requestId: current?.requestId ?? `terminals-changed-${Date.now()}`,
    }));
  }
}

function getActiveServerDataRoute(
  query: Query,
  serverId: string,
  active: ActiveServerDataSubscriptions,
): ServerDataRoute | null {
  if (query.getObserversCount() === 0) {
    return null;
  }
  const route = getServerDataRoute(query);
  if (route) {
    return route.enabled && route.serverId === serverId ? route : null;
  }
  return getActiveRouteForQueryKey({
    active,
    queryKey: query.queryKey,
    serverId,
  });
}

function getActiveRouteForQueryKey(input: {
  active: ActiveServerDataSubscriptions;
  queryKey: QueryKey;
  serverId: string;
}): ServerDataRoute | null {
  return (
    getActiveTerminalRouteForQueryKey({
      active: input.active.workspaceTerminals,
      queryKey: input.queryKey,
      serverId: input.serverId,
    }) ??
    getActiveCheckoutDiffRouteForQueryKey({
      active: input.active.checkoutDiff,
      queryKey: input.queryKey,
      serverId: input.serverId,
    })
  );
}

function getActiveTerminalRouteForQueryKey(input: {
  active: Map<string, WorkspaceTerminalsRoute>;
  queryKey: QueryKey;
  serverId: string;
}): WorkspaceTerminalsRoute | null {
  if (!isQueryForServer(input.queryKey, "terminals", input.serverId)) {
    return null;
  }
  const cwd = input.queryKey[2];
  const workspaceId = input.queryKey[3];
  if (
    typeof cwd !== "string" ||
    (workspaceId !== undefined && workspaceId !== null && typeof workspaceId !== "string")
  ) {
    return null;
  }
  return input.active.get(`${cwd}\u0000${workspaceId ?? ""}`) ?? null;
}

function getActiveCheckoutDiffRouteForQueryKey(input: {
  active: Map<string, CheckoutDiffRoute>;
  queryKey: QueryKey;
  serverId: string;
}): CheckoutDiffRoute | null {
  if (!isQueryForServer(input.queryKey, "checkoutDiff", input.serverId)) {
    return null;
  }
  for (const route of input.active.values()) {
    if (isCheckoutDiffQueryKeyForRoute(input.queryKey, route)) {
      return route;
    }
  }
  return null;
}

function shouldReconcileSubscriptionsForCacheEvent(
  event: QueryCacheNotifyEvent,
  serverId: string,
  active: ActiveServerDataSubscriptions,
): boolean {
  if (!canEventChangeDesiredSubscriptions(event.type)) {
    return false;
  }
  const route = getServerDataRoute(event.query);
  if (route?.serverId === serverId) {
    return true;
  }
  return (
    getActiveRouteForQueryKey({
      active,
      queryKey: event.query.queryKey,
      serverId,
    }) !== null
  );
}

function canEventChangeDesiredSubscriptions(type: QueryCacheNotifyEvent["type"]): boolean {
  return (
    type === "added" ||
    type === "removed" ||
    type === "observerAdded" ||
    type === "observerRemoved" ||
    type === "observerOptionsUpdated"
  );
}

function getServerDataRoute(query: Query): ServerDataRoute | null {
  const meta = query.meta;
  if (!isRecord(meta) || !isRecord(meta.serverData)) {
    return null;
  }
  return readServerDataRoute(meta.serverData);
}

function readServerDataRoute(value: Record<string, unknown>): ServerDataRoute | null {
  const domain = value.domain;
  const enabled = value.enabled;
  const serverId = value.serverId;
  const cwd = value.cwd;
  if (typeof enabled !== "boolean" || typeof serverId !== "string" || typeof cwd !== "string") {
    return null;
  }

  if (domain === "checkoutDiff") {
    const subscriptionId = value.subscriptionId;
    const compare = readCheckoutDiffCompare(value.compare);
    if (typeof subscriptionId !== "string" || !compare) {
      return null;
    }
    return {
      domain,
      enabled,
      serverId,
      subscriptionId,
      cwd,
      compare,
    };
  }

  if (domain === "workspaceTerminals") {
    const workspaceId = value.workspaceId;
    if (workspaceId !== undefined && typeof workspaceId !== "string") {
      return null;
    }
    return {
      domain,
      enabled,
      serverId,
      cwd,
      ...(workspaceId ? { workspaceId } : {}),
    };
  }

  return null;
}

function readCheckoutDiffCompare(value: unknown): CheckoutDiffCompare | null {
  if (!isRecord(value)) {
    return null;
  }
  const mode = value.mode;
  const baseRef = value.baseRef;
  const ignoreWhitespace = value.ignoreWhitespace;
  if (mode !== "uncommitted" && mode !== "base") {
    return null;
  }
  if (baseRef !== undefined && typeof baseRef !== "string") {
    return null;
  }
  if (ignoreWhitespace !== undefined && typeof ignoreWhitespace !== "boolean") {
    return null;
  }
  return {
    mode,
    ...(baseRef ? { baseRef } : {}),
    ...(ignoreWhitespace !== undefined ? { ignoreWhitespace } : {}),
  };
}

function areCheckoutDiffRoutesEqual(
  left: CheckoutDiffRoute | undefined,
  right: CheckoutDiffRoute,
): boolean {
  return (
    left?.serverId === right.serverId &&
    left.subscriptionId === right.subscriptionId &&
    left.cwd === right.cwd &&
    left.compare.mode === right.compare.mode &&
    left.compare.baseRef === right.compare.baseRef &&
    left.compare.ignoreWhitespace === right.compare.ignoreWhitespace
  );
}

function isCheckoutDiffQueryKeyForRoute(queryKey: QueryKey, route: CheckoutDiffRoute): boolean {
  return (
    queryKey[0] === "checkoutDiff" &&
    queryKey[1] === route.serverId &&
    queryKey[2] === route.cwd &&
    queryKey[3] === route.compare.mode &&
    queryKey[4] === (route.compare.baseRef ?? "") &&
    queryKey[5] === (route.compare.ignoreWhitespace === true)
  );
}

function areWorkspaceTerminalsRoutesEqual(
  left: WorkspaceTerminalsRoute,
  right: WorkspaceTerminalsRoute,
): boolean {
  return (
    left.serverId === right.serverId &&
    left.cwd === right.cwd &&
    left.workspaceId === right.workspaceId
  );
}

function workspaceTerminalSubscriptionKey(route: WorkspaceTerminalsRoute): string {
  return `${route.cwd}\u0000${route.workspaceId ?? ""}`;
}

function workspaceTerminalSubscriptionInput(route: WorkspaceTerminalsRoute): {
  cwd: string;
  workspaceId?: string;
} {
  return {
    cwd: route.cwd,
    ...(route.workspaceId ? { workspaceId: route.workspaceId } : {}),
  };
}

function unsubscribeCheckoutDiff(client: ServerDataPushClient, subscriptionId: string): void {
  try {
    client.unsubscribeCheckoutDiff(subscriptionId);
  } catch {
    // Disconnect cleanup can race with explicit subscription teardown.
  }
}

function isQueryForServer(queryKey: QueryKey, kind: string, serverId: string): boolean {
  return queryKey.length >= 2 && queryKey[0] === kind && queryKey[1] === serverId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDaemonConfigChangedPayload(
  payload: StatusMessage["payload"],
): payload is { status: "daemon_config_changed"; config: MutableDaemonConfig } {
  return payload.status === "daemon_config_changed" && isRecord(payload.config);
}
