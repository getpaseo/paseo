import type {
  AgentSnapshotPayload,
  DaemonUpdateResponse,
  ServerInfoStatusPayload,
  SessionInboundMessage,
  WSOutboundMessage,
} from "@getpaseo/protocol/messages";
import type {
  AgentCreateFailedStatusPayload,
  AgentCreatedStatusPayload,
  AgentRefreshedStatusPayload,
  AgentResumedStatusPayload,
  DaemonProtocolCodec,
  OutboundValidationResult,
  RestartRequestedStatusPayload,
  ShutdownRequestedStatusPayload,
} from "./daemon-protocol-codec.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isCapabilityState(value: unknown): boolean {
  return isRecord(value) && typeof value.enabled === "boolean" && typeof value.reason === "string";
}

function parseServerCapabilities(
  value: unknown,
): ServerInfoStatusPayload["capabilities"] | undefined {
  if (!isRecord(value)) return undefined;
  if (value.voice !== undefined) {
    if (
      !isRecord(value.voice) ||
      !isCapabilityState(value.voice.dictation) ||
      !isCapabilityState(value.voice.voice)
    ) {
      return undefined;
    }
  }
  return value as ServerInfoStatusPayload["capabilities"];
}

function validateOutbound(input: unknown): OutboundValidationResult {
  if (!isRecord(input) || typeof input.type !== "string") {
    return { success: false, error: { message: "Invalid WebSocket message envelope" } };
  }
  if (input.type === "pong") {
    if (
      input.timestamp !== undefined &&
      (typeof input.timestamp !== "number" || !Number.isFinite(input.timestamp))
    ) {
      return { success: false, error: { message: "Invalid pong timestamp" } };
    }
    return { success: true, data: input as unknown as WSOutboundMessage };
  }
  if (input.type === "hello.rejected") {
    if (
      input.reason !== "password_required" &&
      input.reason !== "incorrect_password" &&
      input.reason !== "incompatible_protocol"
    ) {
      return { success: false, error: { message: "Invalid hello.rejected reason" } };
    }
    return { success: true, data: input as unknown as WSOutboundMessage };
  }
  if (input.type === "session") {
    if (!isRecord(input.message) || typeof input.message.type !== "string") {
      return { success: false, error: { message: "Invalid session outbound message" } };
    }
    return { success: true, data: input as unknown as WSOutboundMessage };
  }
  return { success: false, error: { message: `Unknown envelope type: ${input.type}` } };
}

function parseServerInfo(payload: unknown): ServerInfoStatusPayload | null {
  if (!isRecord(payload) || payload.status !== "server_info") return null;
  if (typeof payload.serverId !== "string") return null;
  const serverId = payload.serverId.trim();
  if (serverId.length === 0) return null;
  if (
    payload.protocolVersion !== undefined &&
    (typeof payload.protocolVersion !== "number" || !Number.isInteger(payload.protocolVersion))
  ) {
    return null;
  }
  if (
    payload.machineKind !== undefined &&
    payload.machineKind !== null &&
    typeof payload.machineKind !== "string"
  ) {
    return null;
  }
  if (payload.sourceId !== undefined && typeof payload.sourceId !== "string") return null;
  if (payload.desktopManaged !== undefined && typeof payload.desktopManaged !== "boolean") {
    return null;
  }
  if (payload.features !== undefined && !isRecord(payload.features)) return null;

  const capabilities =
    payload.capabilities === undefined ? undefined : parseServerCapabilities(payload.capabilities);

  return {
    ...payload,
    status: "server_info",
    serverId,
    hostname: trimOptionalString(payload.hostname),
    version: trimOptionalString(payload.version),
    ...(capabilities !== undefined ? { capabilities } : { capabilities: undefined }),
  } as ServerInfoStatusPayload;
}

function parseAgentCreatedStatus(payload: unknown): AgentCreatedStatusPayload | null {
  if (
    !isRecord(payload) ||
    payload.status !== "agent_created" ||
    typeof payload.agentId !== "string" ||
    typeof payload.requestId !== "string" ||
    !isRecord(payload.agent)
  ) {
    return null;
  }
  return payload as unknown as AgentCreatedStatusPayload;
}

function parseAgentCreateFailedStatus(payload: unknown): AgentCreateFailedStatusPayload | null {
  if (
    !isRecord(payload) ||
    payload.status !== "agent_create_failed" ||
    typeof payload.requestId !== "string" ||
    typeof payload.error !== "string"
  ) {
    return null;
  }
  return payload as unknown as AgentCreateFailedStatusPayload;
}

function parseAgentResumedStatus(payload: unknown): AgentResumedStatusPayload | null {
  if (
    !isRecord(payload) ||
    payload.status !== "agent_resumed" ||
    typeof payload.agentId !== "string" ||
    typeof payload.requestId !== "string" ||
    !isRecord(payload.agent)
  ) {
    return null;
  }
  return payload as unknown as AgentResumedStatusPayload;
}

function parseAgentRefreshedStatus(payload: unknown): AgentRefreshedStatusPayload | null {
  if (
    !isRecord(payload) ||
    payload.status !== "agent_refreshed" ||
    typeof payload.agentId !== "string" ||
    typeof payload.requestId !== "string"
  ) {
    return null;
  }
  return payload as unknown as AgentRefreshedStatusPayload;
}

function parseRestartRequestedStatus(payload: unknown): RestartRequestedStatusPayload | null {
  if (
    !isRecord(payload) ||
    payload.status !== "restart_requested" ||
    typeof payload.clientId !== "string" ||
    typeof payload.requestId !== "string"
  ) {
    return null;
  }
  return payload as unknown as RestartRequestedStatusPayload;
}

function parseShutdownRequestedStatus(payload: unknown): ShutdownRequestedStatusPayload | null {
  if (
    !isRecord(payload) ||
    payload.status !== "shutdown_requested" ||
    typeof payload.clientId !== "string" ||
    typeof payload.requestId !== "string"
  ) {
    return null;
  }
  return payload as unknown as ShutdownRequestedStatusPayload;
}

function parseDaemonUpdateResponse(message: unknown): DaemonUpdateResponse | null {
  if (!isRecord(message) || message.type !== "daemon.update.response") return null;
  const payload = message.payload;
  if (
    !isRecord(payload) ||
    typeof payload.requestId !== "string" ||
    typeof payload.success !== "boolean" ||
    (payload.error !== null && typeof payload.error !== "string") ||
    (payload.previousVersion !== null && typeof payload.previousVersion !== "string") ||
    (payload.newVersion !== null && typeof payload.newVersion !== "string")
  ) {
    return null;
  }
  return message as unknown as DaemonUpdateResponse;
}

function parseAgentSnapshot(value: unknown): AgentSnapshotPayload {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new Error("Invalid agent snapshot payload");
  }
  return value as unknown as AgentSnapshotPayload;
}

function matchesBrowserRegistration(
  advertised: unknown,
  request: Record<string, unknown>,
): boolean {
  if (
    !isRecord(advertised) ||
    typeof advertised.hostKind !== "string" ||
    !Array.isArray(advertised.supportedCommands) ||
    advertised.hostKind !== request.hostKind ||
    !Array.isArray(request.supportedCommands)
  ) {
    return false;
  }
  for (const command of request.supportedCommands) {
    if (!advertised.supportedCommands.some((supported) => supported === command)) {
      return false;
    }
  }
  return true;
}

function parseInbound(message: unknown): SessionInboundMessage {
  if (!isRecord(message) || typeof message.type !== "string") {
    throw new Error("Invalid session inbound message");
  }
  if (message.type === "create_agent_request" && message.labels === undefined) {
    return { ...message, labels: {} } as unknown as SessionInboundMessage;
  }
  if (message.type === "capture_terminal_request" && message.stripAnsi === undefined) {
    return { ...message, stripAnsi: true } as unknown as SessionInboundMessage;
  }
  return message as unknown as SessionInboundMessage;
}

export const leanProtocolCodec: DaemonProtocolCodec = {
  validateOutbound,
  parseInbound,
  parseServerInfo,
  parseAgentCreatedStatus,
  parseAgentCreateFailedStatus,
  parseAgentResumedStatus,
  parseAgentRefreshedStatus,
  parseRestartRequestedStatus,
  parseShutdownRequestedStatus,
  parseDaemonUpdateResponse,
  parseAgentSnapshot,
  matchesBrowserRegistration,
};
