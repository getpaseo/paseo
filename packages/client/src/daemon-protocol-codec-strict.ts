import { BrowserAutomationHostCapabilitySchema } from "@getpaseo/protocol/browser-automation/capabilities";
import {
  AgentCreateFailedStatusPayloadSchema,
  AgentCreatedStatusPayloadSchema,
  AgentRefreshedStatusPayloadSchema,
  AgentResumedStatusPayloadSchema,
  AgentSnapshotPayloadSchema,
  DaemonUpdateResponseSchema,
  RestartRequestedStatusPayloadSchema,
  SessionInboundMessageSchema,
  ShutdownRequestedStatusPayloadSchema,
  parseServerInfoStatusPayload,
} from "@getpaseo/protocol/messages";
import { validateWSOutboundMessage } from "@getpaseo/protocol/validation/ws-outbound";
import type { DaemonProtocolCodec } from "./daemon-protocol-codec.js";

export const strictProtocolCodec: DaemonProtocolCodec = {
  validateOutbound(input) {
    return validateWSOutboundMessage(input);
  },
  parseInbound(message) {
    return SessionInboundMessageSchema.parse(message);
  },
  parseServerInfo(payload) {
    return parseServerInfoStatusPayload(payload);
  },
  parseAgentCreatedStatus(payload) {
    const parsed = AgentCreatedStatusPayloadSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  },
  parseAgentCreateFailedStatus(payload) {
    const parsed = AgentCreateFailedStatusPayloadSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  },
  parseAgentResumedStatus(payload) {
    const parsed = AgentResumedStatusPayloadSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  },
  parseAgentRefreshedStatus(payload) {
    const parsed = AgentRefreshedStatusPayloadSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  },
  parseRestartRequestedStatus(payload) {
    const parsed = RestartRequestedStatusPayloadSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  },
  parseShutdownRequestedStatus(payload) {
    const parsed = ShutdownRequestedStatusPayloadSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  },
  parseDaemonUpdateResponse(message) {
    const parsed = DaemonUpdateResponseSchema.safeParse(message);
    return parsed.success ? parsed.data : null;
  },
  parseAgentSnapshot(value) {
    return AgentSnapshotPayloadSchema.parse(value);
  },
  matchesBrowserRegistration(advertised, request) {
    const host = BrowserAutomationHostCapabilitySchema.safeParse(advertised);
    if (!host.success) return false;
    if (host.data.hostKind !== request.hostKind) return false;
    for (const command of (request.supportedCommands as string[]) ?? []) {
      if (!host.data.supportedCommands.some((supported) => supported === command)) return false;
    }
    return true;
  },
};
