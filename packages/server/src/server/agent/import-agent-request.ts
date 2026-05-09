import type { z } from "zod";
import type { ImportAgentRequestMessageSchema } from "../../shared/messages.js";

type ImportAgentRequestMessage = z.infer<typeof ImportAgentRequestMessageSchema>;

export interface NormalizedImportAgentRequest {
  provider: string;
  providerHandleId: string;
  cwd?: string;
  labels?: Record<string, string>;
  requestId: string;
}

// COMPAT(import-agent-request-v1): accept legacy {provider, sessionId} shape
// alongside the new {providerId, providerHandleId} shape. Old clients
// (< target daemon floor) send the legacy fields. Drop the fallbacks and the
// .optional() in messages.ts when the supported client floor is >= the daemon
// version that ships the new shape (target: 2026-11-08).
export function normalizeImportAgentRequest(
  msg: ImportAgentRequestMessage,
): NormalizedImportAgentRequest | { error: string } {
  const provider = msg.providerId ?? msg.provider;
  const providerHandleId = msg.providerHandleId ?? msg.sessionId;
  if (!provider || !providerHandleId) {
    return { error: "Import requires providerId and providerHandleId" };
  }
  return {
    provider,
    providerHandleId,
    cwd: msg.cwd,
    labels: msg.labels,
    requestId: msg.requestId,
  };
}
