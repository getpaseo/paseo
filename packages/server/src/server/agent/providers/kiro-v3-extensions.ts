import type { AgentCapabilities, SessionInfoUpdate } from "@agentclientprotocol/sdk";

import type { ACPExtensionCommand, ACPSessionInfoUsageParser } from "./acp-agent.js";

// Kiro CLI V3 behavior that Paseo detects from the protocol itself, not from the provider id.
// Wrapper launchers and custom providers that extend the generic ACP client reach the same agent,
// so these hooks are the generic client's defaults and stay inert for agents that send no
// `_meta.kiro`.

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function readKiroMeta(meta: unknown): Record<string, unknown> | null {
  return isRecord(meta) && isRecord(meta.kiro) ? meta.kiro : null;
}

// V3 reports context-window occupancy as a percentage in a `session_info_update` tagged
// `_meta.kiro.kind = "context_usage"`; it reports no token counts, so the percentage travels as-is.
// A local replay marks its updates with `_meta.kiro.replay`, and those describe past state.
export const parseKiroContextUsage: ACPSessionInfoUsageParser = (update: SessionInfoUpdate) => {
  const kiro = readKiroMeta(update._meta);
  if (kiro?.kind !== "context_usage" || kiro.replay === true) {
    return null;
  }
  const percentage = kiro.usagePercentage;
  if (typeof percentage !== "number" || !Number.isFinite(percentage) || percentage < 0) {
    return null;
  }
  return { contextWindowUsagePercentage: percentage };
};

const KIRO_SESSION_COMPACT_METHOD = "_kiro/session/compact";

// V3 advertises its optional request methods in the initialize result, and the advertisement is
// authoritative. An agent without the list is not V3 (Kiro v2, or not Kiro at all), so nothing is
// known about it.
function kiroCompactAvailability(
  capabilities: AgentCapabilities | null,
): ReturnType<ACPExtensionCommand["availability"]> {
  const methods = readKiroMeta(capabilities?._meta)?.extensionMethods;
  if (!Array.isArray(methods)) {
    return "unknown";
  }
  return methods.includes(KIRO_SESSION_COMPACT_METHOD) ? "available" : "unavailable";
}

// V3 removed `_kiro.dev/commands/execute`, so `/compact` is no longer a prompt the agent
// understands. It runs the typed compaction request on the live session instead.
export const kiroCompactCommand: ACPExtensionCommand = {
  name: "compact",
  description: "Summarize the conversation to free up context",
  availability: kiroCompactAvailability,
  run: async ({ connection, sessionId }) => {
    await connection.extMethod(KIRO_SESSION_COMPACT_METHOD, { sessionId });
    return "Conversation compacted.";
  },
};
