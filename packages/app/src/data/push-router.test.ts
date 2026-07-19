import { QueryClient, QueryObserver, skipToken } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { MutableDaemonConfig, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { checkoutDiffQueryKey } from "@/git/query-keys";
import { buildTerminalsQueryKey } from "@/screens/workspace/terminals/state";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import { providersSnapshotQueryKey } from "@/data/providers-snapshot";
import {
  checkoutDiffPushRoute,
  invalidateServerDataQueriesAfterReconnect,
  mountServerDataPushRouter,
  workspaceTerminalsPushRoute,
} from "@/data/push-router";

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
type RouterMessage =
  | ProvidersSnapshotUpdateMessage
  | CheckoutDiffUpdateMessage
  | SubscribeCheckoutDiffResponseMessage
  | StatusMessage
  | TerminalsChangedMessage;
type RouterMessageType = RouterMessage["type"];
type RouterHandler = (message: RouterMessage) => void;
type RouterClient = Parameters<typeof mountServerDataPushRouter>[0]["client"];

const daemonConfig: MutableDaemonConfig = {
  mcp: { injectIntoAgents: true },
  browserTools: { enabled: false },
  providers: {},
  metadataGeneration: { providers: [] },
  autoArchiveAfterMerge: false,
  enableTerminalAgentHooks: false,
  appendSystemPrompt: "",
};

function createFakeClient(config: { rejectCheckoutDiffSubscribe?: boolean } = {}): {
  client: RouterClient;
  emit: <K extends RouterMessageType>(message: Extract<RouterMessage, { type: K }>) => void;
  subscribeCheckoutDiffCalls: Array<{
    cwd: string;
    compare: { mode: "uncommitted" | "base"; baseRef?: string; ignoreWhitespace?: boolean };
    subscriptionId: string;
  }>;
  unsubscribeCheckoutDiffCalls: string[];
  subscribeTerminalCalls: Array<{ cwd: string; workspaceId?: string }>;
  unsubscribeTerminalCalls: Array<{ cwd: string; workspaceId?: string }>;
} {
  const handlers: Record<RouterMessageType, RouterHandler[]> = {
    providers_snapshot_update: [],
    checkout_diff_update: [],
    subscribe_checkout_diff_response: [],
    status: [],
    terminals_changed: [],
  };
  const subscribeCheckoutDiffCalls: Array<{
    cwd: string;
    compare: { mode: "uncommitted" | "base"; baseRef?: string; ignoreWhitespace?: boolean };
    subscriptionId: string;
  }> = [];
  const unsubscribeCheckoutDiffCalls: string[] = [];
  const subscribeTerminalCalls: Array<{ cwd: string; workspaceId?: string }> = [];
  const unsubscribeTerminalCalls: Array<{ cwd: string; workspaceId?: string }> = [];

  function on<K extends RouterMessageType>(
    type: K,
    handler: (message: Extract<RouterMessage, { type: K }>) => void,
  ): () => void {
    const routerHandler: RouterHandler = (message) => {
      if (message.type === type) {
        handler(message as Extract<RouterMessage, { type: K }>);
      }
    };
    handlers[type].push(routerHandler);
    return () => {
      handlers[type] = handlers[type].filter((candidate) => candidate !== routerHandler);
    };
  }

  function emit<K extends RouterMessageType>(message: Extract<RouterMessage, { type: K }>): void {
    for (const handler of handlers[message.type]) {
      handler(message);
    }
  }

  return {
    client: {
      on,
      async subscribeCheckoutDiff(cwd, compare, requestOptions) {
        subscribeCheckoutDiffCalls.push({
          cwd,
          compare,
          subscriptionId: requestOptions.subscriptionId,
        });
        if (config.rejectCheckoutDiffSubscribe) {
          throw new Error("subscribe failed");
        }
        return {
          subscriptionId: requestOptions.subscriptionId,
          cwd,
          files: [],
          error: null,
          requestId: requestOptions.requestId ?? "subscribe-checkout-diff",
        };
      },
      unsubscribeCheckoutDiff(subscriptionId) {
        unsubscribeCheckoutDiffCalls.push(subscriptionId);
      },
      subscribeTerminals(subscription) {
        subscribeTerminalCalls.push(subscription);
      },
      unsubscribeTerminals(subscription) {
        unsubscribeTerminalCalls.push(subscription);
      },
    },
    emit,
    subscribeCheckoutDiffCalls,
    unsubscribeCheckoutDiffCalls,
    subscribeTerminalCalls,
    unsubscribeTerminalCalls,
  };
}

function providerUpdate(generatedAt: string): ProvidersSnapshotUpdateMessage {
  return {
    type: "providers_snapshot_update",
    payload: {
      entries: [{ provider: "codex", status: "ready", enabled: true, models: [] }],
      generatedAt,
    },
  };
}

describe("server data push router", () => {
  it("routes provider snapshot and daemon config payloads until detached", () => {
    const queryClient = new QueryClient();
    const fake = createFakeClient();
    const serverId = "server-1";
    const unmount = mountServerDataPushRouter({ client: fake.client, queryClient, serverId });

    fake.emit(providerUpdate("2026-01-01T00:00:00.000Z"));
    fake.emit({
      type: "status",
      payload: { status: "daemon_config_changed", config: daemonConfig },
    });

    expect(queryClient.getQueryData(providersSnapshotQueryKey(serverId))).toEqual({
      entries: [{ provider: "codex", status: "ready", enabled: true, models: [] }],
      generatedAt: "2026-01-01T00:00:00.000Z",
      requestId: "providers_snapshot_update",
    });
    expect(queryClient.getQueryData(daemonConfigQueryKey(serverId))).toEqual(daemonConfig);

    unmount();
    fake.emit(providerUpdate("2026-01-01T00:00:01.000Z"));

    expect(queryClient.getQueryData(providersSnapshotQueryKey(serverId))).toEqual({
      entries: [{ provider: "codex", status: "ready", enabled: true, models: [] }],
      generatedAt: "2026-01-01T00:00:00.000Z",
      requestId: "providers_snapshot_update",
    });
  });

  it("subscribes active checkout diff queries and writes matching diff events", () => {
    const queryClient = new QueryClient();
    const fake = createFakeClient();
    const serverId = "server-1";
    const cwd = "/repo";
    const queryKey = checkoutDiffQueryKey(serverId, cwd, "base", "main", true);
    const subscriptionId = `checkoutDiff:${JSON.stringify(queryKey)}`;
    const observer = new QueryObserver(queryClient, {
      queryKey,
      queryFn: skipToken,
      enabled: true,
      gcTime: Infinity,
      staleTime: Infinity,
      meta: checkoutDiffPushRoute({
        enabled: true,
        serverId,
        subscriptionId,
        cwd,
        compare: { mode: "base", baseRef: "main", ignoreWhitespace: true },
      }),
    });
    const unsubscribeObserver = observer.subscribe(() => undefined);
    const unmount = mountServerDataPushRouter({ client: fake.client, queryClient, serverId });

    expect(fake.subscribeCheckoutDiffCalls).toEqual([
      {
        cwd,
        compare: { mode: "base", baseRef: "main", ignoreWhitespace: true },
        subscriptionId,
      },
    ]);

    fake.emit({
      type: "subscribe_checkout_diff_response",
      payload: { subscriptionId, cwd, files: [], error: null, requestId: "diff-1" },
    });

    expect(queryClient.getQueryData(queryKey)).toEqual({
      cwd,
      files: [],
      error: null,
      requestId: "diff-1",
    });

    fake.emit({
      type: "checkout_diff_update",
      payload: { subscriptionId, cwd, files: [], error: null },
    });

    expect(queryClient.getQueryData(queryKey)).toEqual({
      cwd,
      files: [],
      error: null,
      requestId: `subscription:${subscriptionId}`,
    });

    unsubscribeObserver();

    expect(fake.unsubscribeCheckoutDiffCalls).toEqual([subscriptionId]);

    unmount();
  });

  it("does not retry failed subscriptions on unrelated cache events", async () => {
    const queryClient = new QueryClient();
    const fake = createFakeClient({ rejectCheckoutDiffSubscribe: true });
    const serverId = "server-1";
    const cwd = "/repo";
    const queryKey = checkoutDiffQueryKey(serverId, cwd, "base", "main", true);
    const subscriptionId = `checkoutDiff:${JSON.stringify(queryKey)}`;
    const observer = new QueryObserver(queryClient, {
      queryKey,
      queryFn: skipToken,
      enabled: true,
      gcTime: Infinity,
      staleTime: Infinity,
      meta: checkoutDiffPushRoute({
        enabled: true,
        serverId,
        subscriptionId,
        cwd,
        compare: { mode: "base", baseRef: "main", ignoreWhitespace: true },
      }),
    });
    const unsubscribeObserver = observer.subscribe(() => undefined);
    const unmount = mountServerDataPushRouter({ client: fake.client, queryClient, serverId });

    expect(fake.subscribeCheckoutDiffCalls).toHaveLength(1);

    await Promise.resolve();
    await Promise.resolve();

    queryClient.setQueryData(["unrelated"], "value");

    expect(fake.subscribeCheckoutDiffCalls).toHaveLength(1);

    unsubscribeObserver();
    unmount();
  });

  it("subscribes active terminal queries and filters terminal pushes by workspace", () => {
    const queryClient = new QueryClient();
    const fake = createFakeClient();
    const serverId = "server-1";
    const cwd = "/repo";
    const workspaceId = "workspace-a";
    const queryKey = buildTerminalsQueryKey(serverId, cwd, workspaceId);
    const observer = new QueryObserver(queryClient, {
      queryKey,
      queryFn: skipToken,
      enabled: true,
      gcTime: Infinity,
      staleTime: Infinity,
      meta: workspaceTerminalsPushRoute({
        enabled: true,
        serverId,
        cwd,
        workspaceId,
      }),
    });
    const unsubscribeObserver = observer.subscribe(() => undefined);
    const unmount = mountServerDataPushRouter({ client: fake.client, queryClient, serverId });

    expect(fake.subscribeTerminalCalls).toEqual([{ cwd, workspaceId }]);

    fake.emit({
      type: "terminals_changed",
      payload: {
        cwd,
        terminals: [
          { id: "terminal-a", name: "Main", workspaceId },
          { id: "terminal-b", name: "Sibling", workspaceId: "workspace-b" },
        ],
      },
    });

    expect(queryClient.getQueryData(queryKey)).toEqual({
      cwd,
      terminals: [{ id: "terminal-a", name: "Main", workspaceId }],
      requestId: expect.stringMatching(/^terminals-changed-/),
    });

    unsubscribeObserver();

    expect(fake.unsubscribeTerminalCalls).toEqual([{ cwd, workspaceId }]);

    unmount();
  });

  it("re-sends active push subscriptions after reconnect", () => {
    const queryClient = new QueryClient();
    const fake = createFakeClient();
    const serverId = "server-1";
    const cwd = "/repo";
    const workspaceId = "workspace-a";
    const checkoutDiffKey = checkoutDiffQueryKey(serverId, cwd, "base", "main", true);
    const checkoutDiffSubscriptionId = `checkoutDiff:${JSON.stringify(checkoutDiffKey)}`;
    const terminalKey = buildTerminalsQueryKey(serverId, cwd, workspaceId);
    const checkoutDiffObserver = new QueryObserver(queryClient, {
      queryKey: checkoutDiffKey,
      queryFn: skipToken,
      enabled: true,
      gcTime: Infinity,
      staleTime: Infinity,
      meta: checkoutDiffPushRoute({
        enabled: true,
        serverId,
        subscriptionId: checkoutDiffSubscriptionId,
        cwd,
        compare: { mode: "base", baseRef: "main", ignoreWhitespace: true },
      }),
    });
    const terminalObserver = new QueryObserver(queryClient, {
      queryKey: terminalKey,
      queryFn: skipToken,
      enabled: true,
      gcTime: Infinity,
      staleTime: Infinity,
      meta: workspaceTerminalsPushRoute({
        enabled: true,
        serverId,
        cwd,
        workspaceId,
      }),
    });
    const unsubscribeCheckoutDiffObserver = checkoutDiffObserver.subscribe(() => undefined);
    const unsubscribeTerminalObserver = terminalObserver.subscribe(() => undefined);
    const unmount = mountServerDataPushRouter({ client: fake.client, queryClient, serverId });
    const plainCheckoutDiffObserver = new QueryObserver(queryClient, {
      queryKey: checkoutDiffKey,
      queryFn: skipToken,
      enabled: true,
      gcTime: Infinity,
      staleTime: Infinity,
    });
    const plainTerminalObserver = new QueryObserver(queryClient, {
      queryKey: terminalKey,
      queryFn: skipToken,
      enabled: true,
      gcTime: Infinity,
      staleTime: Infinity,
    });
    const unsubscribePlainCheckoutDiffObserver = plainCheckoutDiffObserver.subscribe(
      () => undefined,
    );
    const unsubscribePlainTerminalObserver = plainTerminalObserver.subscribe(() => undefined);

    invalidateServerDataQueriesAfterReconnect({ queryClient, serverId });

    expect(fake.subscribeCheckoutDiffCalls).toEqual([
      {
        cwd,
        compare: { mode: "base", baseRef: "main", ignoreWhitespace: true },
        subscriptionId: checkoutDiffSubscriptionId,
      },
      {
        cwd,
        compare: { mode: "base", baseRef: "main", ignoreWhitespace: true },
        subscriptionId: checkoutDiffSubscriptionId,
      },
    ]);
    expect(fake.subscribeTerminalCalls).toEqual([
      { cwd, workspaceId },
      { cwd, workspaceId },
    ]);

    fake.emit({
      type: "terminals_changed",
      payload: {
        cwd,
        terminals: [
          { id: "terminal-a", name: "Main", workspaceId },
          { id: "terminal-b", name: "Sibling", workspaceId: "workspace-b" },
        ],
      },
    });

    expect(queryClient.getQueryData(terminalKey)).toEqual({
      cwd,
      terminals: [{ id: "terminal-a", name: "Main", workspaceId }],
      requestId: expect.stringMatching(/^terminals-changed-/),
    });

    unsubscribePlainCheckoutDiffObserver();
    unsubscribePlainTerminalObserver();
    unsubscribeCheckoutDiffObserver();
    unsubscribeTerminalObserver();
    unmount();
  });

  it("routes terminal pushes after another observer attaches without push metadata", () => {
    const queryClient = new QueryClient();
    const fake = createFakeClient();
    const serverId = "server-1";
    const cwd = "/repo";
    const workspaceId = "workspace-a";
    const queryKey = buildTerminalsQueryKey(serverId, cwd, workspaceId);
    const pushObserver = new QueryObserver(queryClient, {
      queryKey,
      queryFn: skipToken,
      enabled: true,
      gcTime: Infinity,
      staleTime: Infinity,
      meta: workspaceTerminalsPushRoute({
        enabled: true,
        serverId,
        cwd,
        workspaceId,
      }),
    });
    const unsubscribePushObserver = pushObserver.subscribe(() => undefined);
    const unmount = mountServerDataPushRouter({ client: fake.client, queryClient, serverId });
    expect(fake.subscribeTerminalCalls).toEqual([{ cwd, workspaceId }]);

    const plainObserver = new QueryObserver(queryClient, {
      queryKey,
      queryFn: skipToken,
      enabled: true,
      gcTime: Infinity,
      staleTime: Infinity,
    });
    const unsubscribePlainObserver = plainObserver.subscribe(() => undefined);

    fake.emit({
      type: "terminals_changed",
      payload: {
        cwd,
        terminals: [
          {
            id: "terminal-a",
            name: "Main",
            workspaceId,
            activity: { state: "idle", attentionReason: "needs_input", changedAt: 1 },
          },
        ],
      },
    });

    expect(queryClient.getQueryData(queryKey)).toEqual({
      cwd,
      terminals: [
        {
          id: "terminal-a",
          name: "Main",
          workspaceId,
          activity: { state: "idle", attentionReason: "needs_input", changedAt: 1 },
        },
      ],
      requestId: expect.stringMatching(/^terminals-changed-/),
    });
    expect(fake.unsubscribeTerminalCalls).toEqual([]);

    unsubscribePlainObserver();
    unsubscribePushObserver();
    unmount();
  });

  it("invalidates only the reconnect-repair scopes for one server", () => {
    const queryClient = new QueryClient();
    const serverId = "server-1";
    const otherServerId = "server-2";
    const providerKey = providersSnapshotQueryKey(serverId);
    const daemonConfigKey = daemonConfigQueryKey(serverId);
    const diffKey = checkoutDiffQueryKey(serverId, "/repo", "uncommitted", undefined, false);
    const terminalKey = buildTerminalsQueryKey(serverId, "/repo", "workspace-a");
    const otherProviderKey = providersSnapshotQueryKey(otherServerId);

    queryClient.setQueryData(providerKey, { entries: [], generatedAt: "now", requestId: "p" });
    queryClient.setQueryData(daemonConfigKey, daemonConfig);
    queryClient.setQueryData(diffKey, { cwd: "/repo", files: [], error: null, requestId: "d" });
    queryClient.setQueryData(terminalKey, { cwd: "/repo", terminals: [], requestId: "t" });
    queryClient.setQueryData(otherProviderKey, {
      entries: [],
      generatedAt: "now",
      requestId: "other",
    });

    invalidateServerDataQueriesAfterReconnect({ queryClient, serverId });

    expect(queryClient.getQueryState(providerKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(daemonConfigKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(diffKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(terminalKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherProviderKey)?.isInvalidated).toBe(false);
  });
});
