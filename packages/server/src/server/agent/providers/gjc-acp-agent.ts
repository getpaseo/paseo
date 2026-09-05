import type { Logger } from "pino";

import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";

import type { AgentTimelineItem } from "../agent-sdk-types.js";
import type { ProviderSubagentInputEvent } from "../provider-subagents/store.js";
import type { ACPExtensionSubagentParser, ACPExtensionTurnSignalParser } from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

interface GjcACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

// GJC publishes subagent/background-task state through this ACP extension
// notification (per the `_`-prefixed vendor namespace convention). The payload
// carries `ProviderSubagentInputEvent`-shaped entries that feed Paseo's
// provider-subagent store: the subagents track, the read-only timeline panel,
// and status reconciliation all consume those events unchanged.
const GJC_SUBAGENT_UPDATE_METHOD = "_gjc/sdk/subagent/update";

const SUBAGENT_EVENT_TYPES = new Set(["upsert", "timeline", "remove"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Structural validation of the timeline-item discriminated union against the
 * protocol's authoritative schema. The provider-subagent store and the client
 * outbound validator both consume `AgentTimelineItem`; a partial row (e.g. a
 * tool_call without callId/name/status/error/detail) would crash content
 * bounding or fail client outbound-message validation, so it must be dropped
 * at this external boundary rather than cast through.
 */
function isValidTimelineItem(value: unknown): boolean {
  return AgentTimelineItemPayloadSchema.safeParse(value).success;
}

/**
 * The provider-subagent store distinguishes omitted fields (retain the
 * previous value) from explicit `null` (clear it), so both strings and
 * explicit nulls must be forwarded; anything else is treated as omitted.
 */
function stringOrNull(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

function normalizeSubagentUpdate(params: Record<string, unknown>): ProviderSubagentInputEvent[] {
  const raw = params.subagents;
  if (!raw) {
    return [];
  }
  const entries = Array.isArray(raw) ? raw : [raw];
  const result: ProviderSubagentInputEvent[] = [];
  for (const entry of entries) {
    const normalized = normalizeSubagentEntry(entry);
    if (normalized) {
      result.push(normalized);
    }
  }
  return result;
}

function isSubagentStatus(
  value: unknown,
): value is "running" | "completed" | "failed" | "canceled" {
  return value === "running" || value === "completed" || value === "failed" || value === "canceled";
}

function normalizeSubagentEntry(entry: unknown): ProviderSubagentInputEvent | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  const type = entry.type;
  const id = entry.id;
  if (typeof type !== "string" || !SUBAGENT_EVENT_TYPES.has(type)) {
    return undefined;
  }
  if (typeof id !== "string" || id.length === 0) {
    return undefined;
  }
  if (type === "remove") {
    return { type: "remove", id };
  }
  if (type === "timeline") {
    // A timeline entry carries a Paseo timeline item; validate it against the
    // discriminated union so a malformed row can never crash the store.
    if (!isValidTimelineItem(entry.item)) {
      return undefined;
    }
    return {
      type: "timeline",
      id,
      item: entry.item as AgentTimelineItem,
      ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
    };
  }
  const title = stringOrNull(entry.title);
  const description = stringOrNull(entry.description);
  const toolCallId = stringOrNull(entry.toolCallId);
  const cwd = stringOrNull(entry.cwd);
  const subtitle = stringOrNull(entry.subtitle);
  return {
    type: "upsert",
    id,
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(isSubagentStatus(entry.status) ? { status: entry.status } : {}),
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(subtitle !== undefined ? { subtitle } : {}),
    ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
  };
}

// Provider-specific parser injected into the generic ACP session via the
// `subagentUpdateParser` option (mirrors how Kiro injects its extension
// commands parser). GJC reports subagent/background-task state through the
// `_gjc/sdk/subagent/update` extension notification instead of any standard
// ACP message; this recognizes that one method and returns the parsed
// provider-subagent store events (possibly empty), or null for any other
// notification so the base session ignores it.
export const parseGjcExtensionSubagents: ACPExtensionSubagentParser = (method, params) => {
  if (method !== GJC_SUBAGENT_UPDATE_METHOD) {
    return null;
  }
  return normalizeSubagentUpdate(params);
};

// GJC declares its background/fresh-turn lifecycle through these extension
// notifications. Unlike a spontaneous `session/update`, a start signal is an
// explicit statement that a non-foreground turn is beginning, so the generic
// ACP session may open an autonomous run for it without risking the #2148
// regression (implicit updates must never mint turns).
const GJC_TURN_START_METHOD = "_gjc/sdk/turn/start";
const GJC_TURN_END_METHOD = "_gjc/sdk/turn/end";
const GJC_TURN_FAIL_METHOD = "_gjc/sdk/turn/fail";

/**
 * Maps GJC's turn lifecycle extension notifications onto explicit turn signals.
 */
export const parseGjcTurnSignal: ACPExtensionTurnSignalParser = (method, params) => {
  if (method === GJC_TURN_START_METHOD) {
    return { type: "start" };
  }
  if (method === GJC_TURN_END_METHOD) {
    return { type: "end" };
  }
  if (method === GJC_TURN_FAIL_METHOD) {
    const error =
      typeof params.error === "string" && params.error.length > 0
        ? params.error
        : "Autonomous turn failed";
    return { type: "fail", error };
  }
  return null;
};

export class GjcACPAgentClient extends GenericACPAgentClient {
  constructor(options: GjcACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      subagentUpdateParser: parseGjcExtensionSubagents,
      turnSignalParser: parseGjcTurnSignal,
    });
  }
}
