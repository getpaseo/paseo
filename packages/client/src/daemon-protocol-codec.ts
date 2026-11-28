import type { z } from "zod";
import type {
  AgentCreateFailedStatusPayloadSchema,
  AgentCreatedStatusPayloadSchema,
  AgentRefreshedStatusPayloadSchema,
  AgentResumedStatusPayloadSchema,
  AgentSnapshotPayload,
  DaemonUpdateResponse,
  RestartRequestedStatusPayloadSchema,
  ServerInfoStatusPayload,
  SessionInboundMessage,
  ShutdownRequestedStatusPayloadSchema,
  WSOutboundMessage,
} from "@getpaseo/protocol/messages";

export type OutboundValidationResult =
  | { success: true; data: WSOutboundMessage }
  | { success: false; error: { message: string } };

export type AgentCreatedStatusPayload = z.infer<typeof AgentCreatedStatusPayloadSchema>;
export type AgentCreateFailedStatusPayload = z.infer<typeof AgentCreateFailedStatusPayloadSchema>;
export type AgentResumedStatusPayload = z.infer<typeof AgentResumedStatusPayloadSchema>;
export type AgentRefreshedStatusPayload = z.infer<typeof AgentRefreshedStatusPayloadSchema>;
export type RestartRequestedStatusPayload = z.infer<typeof RestartRequestedStatusPayloadSchema>;
export type ShutdownRequestedStatusPayload = z.infer<typeof ShutdownRequestedStatusPayloadSchema>;

export interface DaemonProtocolCodec {
  validateOutbound(input: unknown): OutboundValidationResult;
  parseInbound(message: unknown): SessionInboundMessage;
  parseServerInfo(payload: unknown): ServerInfoStatusPayload | null;
  parseAgentCreatedStatus(payload: unknown): AgentCreatedStatusPayload | null;
  parseAgentCreateFailedStatus(payload: unknown): AgentCreateFailedStatusPayload | null;
  parseAgentResumedStatus(payload: unknown): AgentResumedStatusPayload | null;
  parseAgentRefreshedStatus(payload: unknown): AgentRefreshedStatusPayload | null;
  parseRestartRequestedStatus(payload: unknown): RestartRequestedStatusPayload | null;
  parseShutdownRequestedStatus(payload: unknown): ShutdownRequestedStatusPayload | null;
  parseDaemonUpdateResponse(message: unknown): DaemonUpdateResponse | null;
  parseAgentSnapshot(value: unknown): AgentSnapshotPayload;
  matchesBrowserRegistration(advertised: unknown, request: Record<string, unknown>): boolean;
}
