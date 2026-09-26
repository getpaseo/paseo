import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { getPaseoToolLeafName } from "@getpaseo/protocol/tool-name-normalization";

export interface BrowserHandoffToolCall {
  browserId: string;
  reason: string;
  /** Null until the tool result arrives. */
  handoffId: string | null;
}

// Providers wrap MCP results differently (structured content, text blocks, strings); the tool
// prints this marker in its text so every wrapping still carries the id.
const HANDOFF_ID_PATTERN = /handoffId=([0-9a-f-]{36})/i;

export function isBrowserHandoffToolName(name: string): boolean {
  return getPaseoToolLeafName(name) === "browser_handoff";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readBrowserHandoffToolCall(
  name: string,
  detail: ToolCallDetail,
): BrowserHandoffToolCall | null {
  if (!isBrowserHandoffToolName(name) || detail.type !== "unknown" || !isRecord(detail.input)) {
    return null;
  }
  const { browserId, reason } = detail.input;
  if (typeof browserId !== "string" || typeof reason !== "string") return null;
  const match = JSON.stringify(detail.output ?? null).match(HANDOFF_ID_PATTERN);
  return { browserId, reason, handoffId: match?.[1] ?? null };
}
