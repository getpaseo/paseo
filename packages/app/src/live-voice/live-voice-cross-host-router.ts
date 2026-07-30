import {
  LiveVoiceToolExecutionRejectedError,
  type DaemonClient,
} from "@getpaseo/client/internal/daemon-client";
import type {
  VoiceLiveRouteError,
  VoiceLiveRouteHost,
  VoiceLiveRouteRequest,
  VoiceLiveToolResult,
} from "@getpaseo/protocol/live-voice-routing";

type LiveVoiceRouteSourceClient = Pick<DaemonClient, "on" | "sendLiveVoiceRouteResponse">;

interface LiveVoiceToolTargetClient {
  executeLiveVoiceTool(input: {
    toolName: string;
    arguments: Extract<VoiceLiveRouteRequest["operation"], { kind: "execute_tool" }>["arguments"];
  }): Promise<VoiceLiveToolResult>;
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
  };
}

interface PinnedHostConnection {
  client: LiveVoiceToolTargetClient;
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
  sourceClient: LiveVoiceRouteSourceClient;
  deps: LiveVoiceCrossHostRouterDeps;
  onError?: (error: unknown) => void;
}

/**
 * Mounts the client-owned bridge between one Live Voice source daemon and the
 * app's saved host registry. The returned function only stops new requests;
 * already-pinned operations are allowed to finish and release their pin.
 */
export function mountLiveVoiceCrossHostRouter(
  options: MountLiveVoiceCrossHostRouterOptions,
): () => void {
  return options.sourceClient.on("voice.live.route.request", (request) => {
    void handleLiveVoiceCrossHostRouteRequest({
      sourceServerId: options.sourceServerId,
      sourceClient: options.sourceClient,
      deps: options.deps,
      request,
    }).catch((error) => {
      options.onError?.(error);
    });
  });
}

export async function handleLiveVoiceCrossHostRouteRequest(input: {
  sourceServerId: string;
  sourceClient: LiveVoiceRouteSourceClient;
  deps: LiveVoiceCrossHostRouterDeps;
  request: VoiceLiveRouteRequest;
}): Promise<void> {
  const { sourceServerId, sourceClient, deps, request } = input;
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

  const operation = request.operation;
  const savedHost = deps.getSavedHosts().find((host) => host.serverId === operation.targetServerId);
  if (!savedHost) {
    sendFailure(sourceClient, request, {
      code: "unknown_host",
      message: "The requested target is not a saved host.",
    });
    return;
  }

  const snapshot = deps.getHostRuntimeSnapshot(operation.targetServerId);
  if (snapshot?.connectionStatus !== "online") {
    sendFailure(sourceClient, request, {
      code: "host_offline",
      message: "The requested target host is offline.",
      retryable: true,
    });
    return;
  }

  if (deps.getHostServerInfo(operation.targetServerId)?.features?.liveVoiceToolExecution !== true) {
    sendFailure(sourceClient, request, {
      code: "tool_execution_unsupported",
      message: "Update the target host to use cross-host Live Voice tools.",
    });
    return;
  }

  const pin = deps.pinActiveConnection(operation.targetServerId);
  if (!pin) {
    sendFailure(sourceClient, request, {
      code: "host_offline",
      message: "The requested target host is offline.",
      retryable: true,
    });
    return;
  }

  try {
    const toolResult = await pin.client.executeLiveVoiceTool({
      toolName: operation.toolName,
      arguments: operation.arguments,
    });
    sourceClient.sendLiveVoiceRouteResponse({
      type: "voice.live.route.response",
      payload: {
        requestId: request.requestId,
        liveSessionId: request.liveSessionId,
        ok: true,
        result: {
          kind: "execute_tool",
          targetServerId: operation.targetServerId,
          toolResult,
        },
      },
    });
  } catch (error) {
    sendFailure(sourceClient, request, normalizeExecutionError(error));
  } finally {
    pin.release();
  }
}

function sanitizeHost(
  host: SavedHostSummary,
  deps: LiveVoiceCrossHostRouterDeps,
): VoiceLiveRouteHost {
  const info = deps.getHostServerInfo(host.serverId);
  return {
    serverId: host.serverId,
    label: host.label.trim() || host.serverId,
    hostname: normalizeOptionalString(info?.hostname),
    version: normalizeOptionalString(info?.version),
    online: deps.getHostRuntimeSnapshot(host.serverId)?.connectionStatus === "online",
    toolExecutionSupported: info?.features?.liveVoiceToolExecution === true,
  };
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
