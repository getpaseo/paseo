import type { StreamItem } from "@/types/stream";

export interface JevDecision {
  id: string;
  timestamp: Date;
  /** Question name, or "route" for a turn Jev re-routed. */
  question: string;
  choice: string | null;
  confidence: number | null;
  latencyMs: number | null;
}

export interface AgentInsights {
  toolCalls: number;
  failedToolCalls: number;
  toolCallsByKind: Record<string, number>;
  testRuns: number;
  compactions: number;
  turns: number;
  jevDecisions: JevDecision[];
  jevLatencyMs: number;
  /** Wall time from the first to the last item in the loaded timeline. */
  spanMs: number;
}

const JEV_TOOL = /system_one_decide$/;
const JEV_ROUTE_PREFIX = "Jev routed this turn:";
const TEST_COMMAND = /\b(test|vitest|jest|pytest|cargo test|go test|playwright)\b/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The MCP result arrives either as the structured object, wrapped in structuredContent,
// or only as the JSON text of its first content block.
function findJevResult(output: unknown): Record<string, unknown> | null {
  if (typeof output === "string") {
    try {
      return findJevResult(JSON.parse(output));
    } catch {
      return null;
    }
  }
  if (!isRecord(output)) return null;
  if (isRecord(output.answers)) return output;
  if (isRecord(output.structuredContent)) return findJevResult(output.structuredContent);
  if (Array.isArray(output.content)) {
    const text = output.content.find((block) => isRecord(block) && block.type === "text");
    return isRecord(text) ? findJevResult(text.text) : null;
  }
  return null;
}

function jevDecisionsFromToolCall(item: StreamItem & { kind: "tool_call" }): JevDecision[] {
  const detail = item.payload.source === "agent" ? item.payload.data.detail : null;
  const output = detail?.type === "unknown" ? detail.output : null;
  const result = findJevResult(output);
  if (!result || !isRecord(result.answers)) return [];
  const latencyMs = typeof result.latencyMs === "number" ? result.latencyMs : null;
  return Object.entries(result.answers).map(([question, answer], index) => ({
    id: `${item.id}:${question}`,
    timestamp: item.timestamp,
    question,
    choice: isRecord(answer) && answer.choice != null ? String(answer.choice) : null,
    confidence:
      isRecord(answer) && typeof answer.confidence === "number" ? answer.confidence : null,
    // The call's latency covers all its questions; count it once.
    latencyMs: index === 0 ? latencyMs : null,
  }));
}

function toolKind(item: StreamItem & { kind: "tool_call" }): string {
  if (item.payload.source !== "agent") return "other";
  const detail = item.payload.data.detail;
  return detail.type === "unknown" ? "other" : detail.type;
}

export function computeAgentInsights(items: readonly StreamItem[]): AgentInsights {
  const insights: AgentInsights = {
    toolCalls: 0,
    failedToolCalls: 0,
    toolCallsByKind: {},
    testRuns: 0,
    compactions: 0,
    turns: 0,
    jevDecisions: [],
    jevLatencyMs: 0,
    spanMs: 0,
  };
  for (const item of items) {
    if (item.kind === "user_message") insights.turns += 1;
    if (item.kind === "compaction") insights.compactions += 1;
    if (item.kind === "notification" && item.message.startsWith(JEV_ROUTE_PREFIX)) {
      insights.jevDecisions.push({
        id: item.id,
        timestamp: item.timestamp,
        question: "route",
        choice: item.message.slice(JEV_ROUTE_PREFIX.length).trim(),
        confidence: null,
        latencyMs: null,
      });
    }
    if (item.kind !== "tool_call") continue;
    const name =
      item.payload.source === "agent" ? item.payload.data.name : item.payload.data.toolName;
    if (JEV_TOOL.test(name)) {
      insights.jevDecisions.push(...jevDecisionsFromToolCall(item));
      continue;
    }
    insights.toolCalls += 1;
    const kind = toolKind(item);
    insights.toolCallsByKind[kind] = (insights.toolCallsByKind[kind] ?? 0) + 1;
    const status = item.payload.data.status;
    if (status === "failed") insights.failedToolCalls += 1;
    const detail = item.payload.source === "agent" ? item.payload.data.detail : null;
    if (detail?.type === "shell" && TEST_COMMAND.test(detail.command)) insights.testRuns += 1;
  }
  insights.jevLatencyMs = insights.jevDecisions.reduce((sum, d) => sum + (d.latencyMs ?? 0), 0);
  const first = items[0]?.timestamp.getTime();
  const last = items.at(-1)?.timestamp.getTime();
  insights.spanMs = first !== undefined && last !== undefined ? Math.max(0, last - first) : 0;
  return insights;
}
