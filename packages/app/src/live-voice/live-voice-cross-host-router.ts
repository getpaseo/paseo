import {
  type AgentAttentionRequiredNotification,
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
  associateRoutedLiveVoiceAgent,
  canMatchPendingRoutedLiveVoiceWork,
  claimRoutedLiveVoiceNotification,
  forgetRoutedLiveVoiceWork,
  forgetRoutedLiveVoiceWorkForSource,
  getAmbientLiveVoiceWatch,
  getRoutedLiveVoiceWork,
  getRoutedLiveVoiceWorkForAgent,
  rememberObservedLiveVoiceCompletion,
  releaseRoutedLiveVoiceNotificationClaim,
  trackRoutedLiveVoiceWork,
} from "@/live-voice/live-voice-work-registry";

type LiveVoiceRouteSourceClient = Pick<
  DaemonClient,
  "on" | "onAgentAttentionRequired" | "sendLiveVoiceRouteResponse"
>;

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
  getAgentSummary(
    serverId: string,
    agentId: string,
  ): {
    title: string | null;
    status?: string;
    lastError?: string | null;
    workspaceName?: string | null;
    projectName?: string | null;
  } | null;
  readAgentCompletionSummary(serverId: string, agentId: string): Promise<string | null>;
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
  const unsubscribeObservedCompletions = options.sourceClient.onAgentAttentionRequired(
    (notification) => {
      void handleClientObservedLiveVoiceCompletion({
        targetServerId: options.sourceServerId,
        deps: options.deps,
        notification,
      }).catch((error) => {
        options.onError?.(error);
      });
    },
  );
  return () => {
    forgetRoutedLiveVoiceWorkForSource(options.sourceServerId);
    unsubscribeObservedCompletions();
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
  await deliverLiveVoiceAgentNotification({
    targetServerId,
    deps,
    tracked,
    notification: message.payload.notification,
    requestId: message.payload.requestId,
  });
}

/**
 * Routes the daemon's ordinary agent-attention signal into Live Voice. This is
 * the source-agnostic path: every prompt/delegation surface converges on the
 * same completion event, and every connected host client mounts this handler.
 */
export async function handleClientObservedLiveVoiceCompletion(input: {
  targetServerId: string;
  deps: LiveVoiceCrossHostRouterDeps;
  notification: AgentAttentionRequiredNotification;
}): Promise<void> {
  const { targetServerId, deps } = input;
  const observed = toObservedAgentNotification(targetServerId, deps, input.notification);
  if (!observed) {
    return;
  }
  await routeClientObservedLiveVoiceCompletion({ targetServerId, deps, observed });
}

/**
 * Directory reconciliation reports this transition for ordinary and delegated
 * agents, including work that completed while a host connection was away.
 * Read the final assistant tail once in response to that event; this is an
 * enrichment read, not a status polling loop.
 */
export async function handleClientObservedLiveVoiceAgentStopped(input: {
  targetServerId: string;
  agentId: string;
  deps: LiveVoiceCrossHostRouterDeps;
}): Promise<void> {
  const { targetServerId, agentId, deps } = input;
  if (!canMatchPendingRoutedLiveVoiceWork(targetServerId, agentId)) {
    return;
  }
  const agent = deps.getAgentSummary(targetServerId, agentId);
  const rawSummary = await deps
    .readAgentCompletionSummary(targetServerId, agentId)
    .catch(() => null);
  const observedWorkspaceName = sanitizeObservedText(agent?.workspaceName ?? "", 200);
  const observedProjectName = sanitizeObservedText(agent?.projectName ?? "", 200);
  const observed: VoiceLiveAgentNotification = {
    agentId,
    title: sanitizeObservedText(agent?.title ?? agentId, 200) || agentId,
    reason: agent?.status === "error" ? "errored" : "turn_completed",
    scope: "agent_turn",
    ...(observedWorkspaceName ? { workspaceName: observedWorkspaceName } : {}),
    ...(observedProjectName ? { projectName: observedProjectName } : {}),
    summary:
      sanitizeObservedText(
        rawSummary ?? (agent?.status === "error" ? (agent.lastError ?? "") : ""),
        1_200,
      ) || null,
  };
  await routeClientObservedLiveVoiceCompletion({ targetServerId, deps, observed });
}

async function routeClientObservedLiveVoiceCompletion(input: {
  targetServerId: string;
  deps: LiveVoiceCrossHostRouterDeps;
  observed: VoiceLiveAgentNotification;
}): Promise<void> {
  const { targetServerId, deps, observed } = input;
  const tracked = getRoutedLiveVoiceWorkForAgent(targetServerId, observed.agentId);
  if (!tracked) {
    if (canMatchPendingRoutedLiveVoiceWork(targetServerId, observed.agentId)) {
      rememberObservedLiveVoiceCompletion({ targetServerId, notification: observed });
    }
    return;
  }
  await deliverLiveVoiceAgentNotification({
    targetServerId,
    deps,
    tracked: { ...tracked, ambient: false },
    notification: observed,
    requestId: tracked.requestId,
  });
}

async function deliverLiveVoiceAgentNotification(input: {
  targetServerId: string;
  deps: LiveVoiceCrossHostRouterDeps;
  tracked: ResolvedReportedWork;
  notification: VoiceLiveAgentNotification;
  requestId: string;
}): Promise<void> {
  const { targetServerId, deps, tracked, notification, requestId } = input;
  if (!deps.isAuthorizedSourceCall(tracked.sourceServerId, tracked.liveSessionId)) {
    return;
  }
  const pin = deps.pinActiveConnection(tracked.sourceServerId);
  if (!pin) {
    return;
  }
  const claimed =
    tracked.ambient || claimRoutedLiveVoiceNotification(requestId, notification.reason);
  if (!claimed) {
    pin.release();
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
        ...notification,
        // Only the app knows what the user calls this machine, and a call can
        // reach several of them.
        ...(hostLabel ? { hostLabel } : {}),
      },
    });
    // Ambient reports have no registry entry to retire — the host's watch stays
    // registered until the call ends, because more will follow.
    if (!tracked.ambient && (!delivery.delivered || notification.reason !== "needs_permission")) {
      forgetRoutedLiveVoiceWork(requestId);
    }
  } catch (error) {
    if (!tracked.ambient) {
      releaseRoutedLiveVoiceNotificationClaim(requestId, notification.reason);
    }
    throw error;
  } finally {
    pin.release();
  }
}

function toObservedAgentNotification(
  targetServerId: string,
  deps: LiveVoiceCrossHostRouterDeps,
  event: AgentAttentionRequiredNotification,
): VoiceLiveAgentNotification | null {
  const reason = event.reason;
  // Permission requests retain their existing target-specific path. Unlike
  // terminal completion, the same agent can legitimately ask more than once.
  if (reason === "permission") {
    return null;
  }
  const embedded = event.notification?.data;
  if (
    embedded &&
    (embedded.serverId !== targetServerId ||
      embedded.agentId !== event.agentId ||
      embedded.reason !== event.reason)
  ) {
    return null;
  }
  const agent = deps.getAgentSummary(targetServerId, event.agentId);
  const title = sanitizeObservedText(agent?.title ?? event.agentId, 200);
  const workspaceName = sanitizeObservedText(agent?.workspaceName ?? "", 200);
  const projectName = sanitizeObservedText(agent?.projectName ?? "", 200);
  return {
    agentId: event.agentId,
    title: title || event.agentId,
    reason: toObservedReason(reason),
    scope: "agent_turn",
    ...(workspaceName ? { workspaceName } : {}),
    ...(projectName ? { projectName } : {}),
    summary: sanitizeObservedText(event.notification?.body ?? "", 1_200) || null,
  };
}

function toObservedReason(
  reason: Exclude<AgentAttentionRequiredNotification["reason"], "permission">,
): string {
  switch (reason) {
    case "finished":
      return "turn_completed";
    case "error":
      return "errored";
  }
}

function sanitizeObservedText(value: string, limit: number): string {
  const redacted = value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(
      /(["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
      "$1[redacted]",
    )
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[redacted]@")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length <= limit ? redacted : `${redacted.slice(0, limit)}…`;
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

  let execution: Awaited<ReturnType<LiveVoiceHostClient["executeLiveVoiceTool"]>>;
  try {
    execution = await pin.client.executeLiveVoiceTool({
      toolName: operation.toolName,
      arguments: operation.arguments,
      requestId: executeRequestId,
      ...(notifyOnAgentFinish ? { notifyOnAgentFinish: true } : {}),
    });
  } catch (error) {
    // The call never completed, so nothing on the target is watching for us.
    forgetRoutedLiveVoiceWork(executeRequestId);
    sendFailure(sourceClient, request, normalizeExecutionError(error));
    pin.release();
    return;
  }
  pin.release();

  let observed: VoiceLiveAgentNotification | null = null;
  if (notifyOnAgentFinish && !execution.backgroundAgentId) {
    forgetRoutedLiveVoiceWork(executeRequestId);
  } else if (notifyOnAgentFinish && execution.backgroundAgentId) {
    observed = associateRoutedLiveVoiceAgent(executeRequestId, execution.backgroundAgentId);
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

  const tracked = getRoutedLiveVoiceWork(executeRequestId);
  if (observed && tracked) {
    await deliverLiveVoiceAgentNotification({
      targetServerId: operation.targetServerId,
      deps,
      tracked: { ...tracked, ambient: false },
      notification: observed,
      requestId: executeRequestId,
    });
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
