import {
  LiveVoiceToolExecutionRejectedError,
  type DaemonClient,
} from "@getpaseo/client/internal/daemon-client";
import type {
  VoiceLiveAgentNotification,
  VoiceLiveAgentUpdate,
  VoiceLiveRouteError,
  VoiceLiveRouteHost,
  VoiceLiveRouteRequest,
  VoiceLiveToolResult,
} from "@getpaseo/protocol/live-voice-routing";
import {
  forgetRoutedLiveVoiceWork,
  forgetRoutedLiveVoiceWorkForSource,
  getAmbientLiveVoiceWatch,
  getRoutedLiveVoiceWork,
  trackRoutedLiveVoiceWork,
} from "@/live-voice/live-voice-work-registry";

type LiveVoiceRouteSourceClient = Pick<DaemonClient, "on" | "sendLiveVoiceRouteResponse">;

interface LiveVoiceHostClient {
  executeLiveVoiceTool(input: {
    toolName: string;
    arguments: Extract<VoiceLiveRouteRequest["operation"], { kind: "execute_tool" }>["arguments"];
    requestId?: string;
    notifyOnAgentFinish?: boolean;
  }): Promise<{ toolResult: VoiceLiveToolResult; backgroundAgentId?: string }>;
  notifyLiveVoiceAgentUpdate(input: {
    liveSessionId: string;
    notification: VoiceLiveAgentNotification;
  }): Promise<{ delivered: boolean }>;
}

interface SavedHostSummary {
  serverId: string;
  label: string;
}

interface HostRuntimeSummary {
  connectionStatus: string;
}

interface HostServerInfoSummary {
  hostname: string | null;
  version: string | null;
  features?: {
    liveVoiceToolExecution?: boolean;
    liveVoiceAgentNotifications?: boolean;
  };
}

interface PinnedHostConnection {
  client: LiveVoiceHostClient;
  release(): void;
}

export interface LiveVoiceCrossHostRouterDeps {
  getSavedHosts(): readonly SavedHostSummary[];
  getHostRuntimeSnapshot(serverId: string): HostRuntimeSummary | null;
  getHostServerInfo(serverId: string): HostServerInfoSummary | null;
  pinActiveConnection(serverId: string): PinnedHostConnection | null;
  isAuthorizedSourceCall(sourceServerId: string, liveSessionId: string): boolean;
}

export interface MountLiveVoiceCrossHostRouterOptions {
  sourceServerId: string;
  sourceClient: LiveVoiceRouteSourceClient & { on: DaemonClient["on"] };
  deps: LiveVoiceCrossHostRouterDeps;
  createRequestId?: () => string;
  onError?: (error: unknown) => void;
}

/**
 * Mounts the client-owned Live Voice bridge for one host. The host plays both
 * parts: it is a *source* when it hosts the call (it asks the app to route), and
 * a *target* when work runs on it (it reports how that work ended). Both legs
 * are mounted here because both are the same trust boundary — the app.
 *
 * The returned function only stops new requests; already-pinned operations are
 * allowed to finish and release their pin.
 */
export function mountLiveVoiceCrossHostRouter(
  options: MountLiveVoiceCrossHostRouterOptions,
): () => void {
  const unsubscribeRouteRequests = options.sourceClient.on(
    "voice.live.route.request",
    (request) => {
      void handleLiveVoiceCrossHostRouteRequest({
        sourceServerId: options.sourceServerId,
        sourceClient: options.sourceClient,
        deps: options.deps,
        ...(options.createRequestId ? { createRequestId: options.createRequestId } : {}),
        request,
      }).catch((error) => {
        options.onError?.(error);
      });
    },
  );
  const unsubscribeAgentUpdates = options.sourceClient.on("voice.live.agent.update", (message) => {
    void handleLiveVoiceAgentUpdate({
      targetServerId: options.sourceServerId,
      deps: options.deps,
      message,
    }).catch((error) => {
      options.onError?.(error);
    });
  });
  return () => {
    forgetRoutedLiveVoiceWorkForSource(options.sourceServerId);
    unsubscribeAgentUpdates();
    unsubscribeRouteRequests();
  };
}

/**
 * Speaks a target host's report into the call it belongs to.
 *
 * Two things have to hold before a report can reach a call: the app must have
 * made the routed call itself (the registry knows the requestId), and the user
 * must still own that exact call on that exact source host. A report for a call
 * that has ended is dropped, not spoken into whatever call came after it.
 */
export async function handleLiveVoiceAgentUpdate(input: {
  targetServerId: string;
  deps: LiveVoiceCrossHostRouterDeps;
  message: VoiceLiveAgentUpdate;
}): Promise<void> {
  const { targetServerId, deps, message } = input;
  const tracked = resolveReportedWork({ targetServerId, message });
  if (!tracked) {
    return;
  }
  if (!deps.isAuthorizedSourceCall(tracked.sourceServerId, tracked.liveSessionId)) {
    return;
  }
  const pin = deps.pinActiveConnection(tracked.sourceServerId);
  if (!pin) {
    return;
  }
  const hostLabel = deps
    .getSavedHosts()
    .find((host) => host.serverId === targetServerId)
    ?.label.trim();
  try {
    const delivery = await pin.client.notifyLiveVoiceAgentUpdate({
      liveSessionId: tracked.liveSessionId,
      notification: {
        ...message.payload.notification,
        // Only the app knows what the user calls this machine, and a call can
        // reach several of them.
        ...(hostLabel ? { hostLabel } : {}),
      },
    });
    // Ambient reports have no registry entry to retire — the host's watch stays
    // registered until the call ends, because more will follow.
    if (
      !tracked.ambient &&
      (!delivery.delivered || message.payload.notification.reason !== "needs_permission")
    ) {
      forgetRoutedLiveVoiceWork(message.payload.requestId);
    }
  } finally {
    pin.release();
  }
}

interface ResolvedReportedWork {
  sourceServerId: string;
  liveSessionId: string;
  ambient: boolean;
}

/**
 * Two ways a report can belong to a call, and they must not be confused.
 *
 * A routed report is matched by the requestId the app itself minted, and only
 * counts from the host it was routed to. An ambient report was never requested,
 * so it is matched by the host that sent it — which is sound only because the
 * app is what enabled that host's watch in the first place. A host that reports
 * unsolicited work the app never asked it to watch resolves to nothing.
 */
function resolveReportedWork(input: {
  targetServerId: string;
  message: VoiceLiveAgentUpdate;
}): ResolvedReportedWork | null {
  const { targetServerId, message } = input;
  if (message.payload.notification.unsolicited) {
    const ambient = getAmbientLiveVoiceWatch(targetServerId);
    return ambient
      ? {
          sourceServerId: ambient.sourceServerId,
          liveSessionId: ambient.liveSessionId,
          ambient: true,
        }
      : null;
  }
  const tracked = getRoutedLiveVoiceWork(message.payload.requestId);
  if (!tracked || tracked.targetServerId !== targetServerId) {
    return null;
  }
  return {
    sourceServerId: tracked.sourceServerId,
    liveSessionId: tracked.liveSessionId,
    ambient: false,
  };
}

export async function handleLiveVoiceCrossHostRouteRequest(input: {
  sourceServerId: string;
  sourceClient: LiveVoiceRouteSourceClient;
  deps: LiveVoiceCrossHostRouterDeps;
  createRequestId?: () => string;
  request: VoiceLiveRouteRequest;
}): Promise<void> {
  const { sourceServerId, sourceClient, deps, request } = input;
  const createRequestId = input.createRequestId ?? createDefaultRequestId;
  if (!deps.isAuthorizedSourceCall(sourceServerId, request.liveSessionId)) {
    sendFailure(sourceClient, request, {
      code: "unauthorized_source_call",
      message: "This route request does not belong to the active Live Voice call.",
    });
    return;
  }

  if (request.operation.kind === "list_hosts") {
    sourceClient.sendLiveVoiceRouteResponse({
      type: "voice.live.route.response",
      payload: {
        requestId: request.requestId,
        liveSessionId: request.liveSessionId,
        ok: true,
        result: {
          kind: "list_hosts",
          hosts: deps.getSavedHosts().map((host) => sanitizeHost(host, deps)),
        },
      },
    });
    return;
  }

  await handleLiveVoiceExecuteRouteRequest({
    sourceServerId,
    sourceClient,
    deps,
    request,
    operation: request.operation,
    createRequestId,
  });
}

async function handleLiveVoiceExecuteRouteRequest(input: {
  sourceServerId: string;
  sourceClient: LiveVoiceRouteSourceClient;
  deps: LiveVoiceCrossHostRouterDeps;
  request: VoiceLiveRouteRequest;
  operation: Extract<VoiceLiveRouteRequest["operation"], { kind: "execute_tool" }>;
  createRequestId: () => string;
}): Promise<void> {
  const { sourceServerId, sourceClient, deps, request, operation, createRequestId } = input;
  const pin = resolveLiveVoiceTargetPin({
    deps,
    sourceClient,
    request,
    targetServerId: operation.targetServerId,
  });
  if (!pin) {
    return;
  }

  const notifyOnAgentFinish = operation.notifyOnAgentFinish === true;
  if (
    notifyOnAgentFinish &&
    (deps.getHostServerInfo(sourceServerId)?.features?.liveVoiceAgentNotifications !== true ||
      deps.getHostServerInfo(operation.targetServerId)?.features?.liveVoiceAgentNotifications !==
        true)
  ) {
    pin.release();
    sendFailure(sourceClient, request, {
      code: "agent_notifications_unsupported",
      message:
        "Both the voice host and target host must be upgraded to report background agent updates.",
    });
    return;
  }
  const executeRequestId = createRequestId();
  if (notifyOnAgentFinish) {
    trackRoutedLiveVoiceWork({
      requestId: executeRequestId,
      sourceServerId,
      targetServerId: operation.targetServerId,
      liveSessionId: request.liveSessionId,
    });
  }

  try {
    const execution = await pin.client.executeLiveVoiceTool({
      toolName: operation.toolName,
      arguments: operation.arguments,
      requestId: executeRequestId,
      ...(notifyOnAgentFinish ? { notifyOnAgentFinish: true } : {}),
    });
    if (notifyOnAgentFinish && !execution.backgroundAgentId) {
      forgetRoutedLiveVoiceWork(executeRequestId);
    }
    sourceClient.sendLiveVoiceRouteResponse({
      type: "voice.live.route.response",
      payload: {
        requestId: request.requestId,
        liveSessionId: request.liveSessionId,
        ok: true,
        result: {
          kind: "execute_tool",
          targetServerId: operation.targetServerId,
          toolResult: execution.toolResult,
        },
      },
    });
  } catch (error) {
    // The call never completed, so nothing on the target is watching for us.
    forgetRoutedLiveVoiceWork(executeRequestId);
    sendFailure(sourceClient, request, normalizeExecutionError(error));
  } finally {
    pin.release();
  }
}

function resolveLiveVoiceTargetPin(input: {
  deps: LiveVoiceCrossHostRouterDeps;
  sourceClient: LiveVoiceRouteSourceClient;
  request: VoiceLiveRouteRequest;
  targetServerId: string;
}): PinnedHostConnection | null {
  const { deps, sourceClient, request, targetServerId } = input;
  const savedHost = deps.getSavedHosts().find((host) => host.serverId === targetServerId);
  if (!savedHost) {
    sendFailure(sourceClient, request, {
      code: "unknown_host",
      message: "The requested target is not a saved host.",
    });
    return null;
  }
  if (deps.getHostRuntimeSnapshot(targetServerId)?.connectionStatus !== "online") {
    sendFailure(sourceClient, request, {
      code: "host_offline",
      message: "The requested target host is offline.",
      retryable: true,
    });
    return null;
  }
  const targetInfo = deps.getHostServerInfo(targetServerId);
  if (targetInfo?.features?.liveVoiceToolExecution !== true) {
    const targetVersion = normalizeOptionalString(targetInfo?.version);
    sendFailure(sourceClient, request, {
      code: "tool_execution_unsupported",
      message: `${savedHost.label.trim() || savedHost.serverId}${
        targetVersion ? ` is running Paseo ${targetVersion} and` : ""
      } must be upgraded before Live Voice can run tools on it.`,
    });
    return null;
  }
  const pin = deps.pinActiveConnection(targetServerId);
  if (!pin) {
    sendFailure(sourceClient, request, {
      code: "host_offline",
      message: "The requested target host is offline.",
      retryable: true,
    });
  }
  return pin;
}

function createDefaultRequestId(): string {
  const cryptoObject = globalThis.crypto as { randomUUID?: () => string } | undefined;
  return typeof cryptoObject?.randomUUID === "function"
    ? cryptoObject.randomUUID()
    : `live-voice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sanitizeHost(
  host: SavedHostSummary,
  deps: LiveVoiceCrossHostRouterDeps,
): VoiceLiveRouteHost {
  const info = deps.getHostServerInfo(host.serverId);
  const online = deps.getHostRuntimeSnapshot(host.serverId)?.connectionStatus === "online";
  const toolExecutionSupported = info?.features?.liveVoiceToolExecution === true;
  const agentNotificationsSupported = info?.features?.liveVoiceAgentNotifications === true;
  const compatibility = resolveHostCompatibility(
    online,
    toolExecutionSupported,
    agentNotificationsSupported,
  );
  return {
    serverId: host.serverId,
    label: host.label.trim() || host.serverId,
    hostname: normalizeOptionalString(info?.hostname),
    version: normalizeOptionalString(info?.version),
    online,
    toolExecutionSupported,
    compatibility,
    agentNotificationsSupported,
  };
}

function resolveHostCompatibility(
  online: boolean,
  toolExecutionSupported: boolean,
  agentNotificationsSupported: boolean,
): VoiceLiveRouteHost["compatibility"] {
  if (!online) {
    return "offline";
  }
  return toolExecutionSupported && agentNotificationsSupported ? "ready" : "upgrade_required";
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeExecutionError(error: unknown): VoiceLiveRouteError {
  if (error instanceof LiveVoiceToolExecutionRejectedError) {
    return {
      code: error.errorCode,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: "target_request_failed",
    message: error instanceof Error ? error.message : "The target host request failed.",
    retryable: true,
  };
}

function sendFailure(
  sourceClient: LiveVoiceRouteSourceClient,
  request: VoiceLiveRouteRequest,
  error: VoiceLiveRouteError,
): void {
  sourceClient.sendLiveVoiceRouteResponse({
    type: "voice.live.route.response",
    payload: {
      requestId: request.requestId,
      liveSessionId: request.liveSessionId,
      ok: false,
      error,
    },
  });
}
