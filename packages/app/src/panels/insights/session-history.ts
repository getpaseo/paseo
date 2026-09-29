import type { AgentHistoryEntry } from "@getpaseo/protocol/messages";

export type OriginGroup =
  | "user"
  | "schedule"
  | "paperclip"
  | "agent"
  | "script"
  | "internal"
  | "unknown";

export interface OriginSummary {
  group: OriginGroup;
  sessions: number;
  deleted: number;
  tokens: number;
  costUsd: number;
}

export function originGroup(origin: string | null): OriginGroup {
  if (!origin) return "unknown";
  const kind = origin.split(":")[0];
  switch (kind) {
    case "user":
    case "schedule":
    case "paperclip":
    case "agent":
    case "internal":
      return kind;
    case "systemd":
    case "process":
    case "script":
      return "script";
    default:
      return "unknown";
  }
}

/** Everything the session read or wrote, cache reads included: that is the context it used. */
export function entryTokens(entry: AgentHistoryEntry): number {
  const usage = entry.usage;
  return usage ? usage.inputTokens + usage.cachedInputTokens + usage.outputTokens : 0;
}

/** Sessions per origin with their summed tokens and cost, biggest spender first. */
export function summarizeHistory(entries: readonly AgentHistoryEntry[]): OriginSummary[] {
  const byGroup = new Map<OriginGroup, OriginSummary>();
  for (const entry of entries) {
    const group = originGroup(entry.origin);
    const summary = byGroup.get(group) ?? { group, sessions: 0, deleted: 0, tokens: 0, costUsd: 0 };
    summary.sessions += 1;
    if (entry.state === "deleted") summary.deleted += 1;
    summary.tokens += entryTokens(entry);
    summary.costUsd += entry.usage?.totalCostUsd ?? 0;
    byGroup.set(group, summary);
  }
  return [...byGroup.values()].sort((a, b) => b.costUsd - a.costUsd || b.sessions - a.sessions);
}
