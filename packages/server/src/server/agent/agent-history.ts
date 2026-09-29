import { ORIGIN_LABEL, getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { AgentHistoryEntry } from "../messages.js";
import type { AgentTombstone, StoredAgentRecord } from "./agent-storage.js";
import type { AgentUsageTotals } from "./agent-usage-totals.js";

interface HistoryInput {
  records: StoredAgentRecord[];
  tombstones: AgentTombstone[];
  /** In-memory totals of running agents, newer than their last persisted record. */
  liveUsage: Map<string, AgentUsageTotals | undefined>;
  since?: string;
  limit?: number;
  includeInternal?: boolean;
}

const DEFAULT_LIMIT = 500;

function toUsage(totals: AgentUsageTotals | undefined): AgentHistoryEntry["usage"] {
  if (!totals) return null;
  const { turns, inputTokens, cachedInputTokens, outputTokens, totalCostUsd } = totals;
  return { turns, inputTokens, cachedInputTokens, outputTokens, totalCostUsd };
}

function entry(
  source: StoredAgentRecord | AgentTombstone,
  extra: Pick<AgentHistoryEntry, "state" | "deletedAt" | "summary" | "model"> & {
    usage: AgentUsageTotals | undefined;
  },
): AgentHistoryEntry {
  const labels = source.labels ?? {};
  return {
    agentId: source.id,
    state: extra.state,
    title: source.title ?? null,
    origin: labels[ORIGIN_LABEL] ?? null,
    parentAgentId: getParentAgentIdFromLabels(labels),
    provider: source.provider,
    model: extra.model,
    cwd: source.cwd,
    workspaceId: source.workspaceId ?? null,
    internal: source.internal ?? false,
    createdAt: source.createdAt,
    lastActivityAt: source.lastActivityAt ?? null,
    archivedAt: source.archivedAt ?? null,
    deletedAt: extra.deletedAt,
    summary: extra.summary,
    usage: toUsage(extra.usage),
    labels,
  };
}

/** Active, archived and deleted agents in one list, newest activity first. */
export function buildAgentHistory(input: HistoryInput): AgentHistoryEntry[] {
  const fromRecords = input.records.map((record) =>
    entry(record, {
      state: record.archivedAt ? "archived" : "active",
      deletedAt: null,
      summary: null,
      model: record.runtimeInfo?.model ?? record.config?.model ?? null,
      usage: input.liveUsage.get(record.id) ?? record.usageTotals,
    }),
  );
  const known = new Set(fromRecords.map((item) => item.agentId));
  const fromTombstones = input.tombstones
    .filter((tombstone) => !known.has(tombstone.id))
    .map((tombstone) =>
      entry(tombstone, {
        state: "deleted",
        deletedAt: tombstone.deletedAt,
        summary: tombstone.summary ?? null,
        model: tombstone.model ?? null,
        usage: tombstone.usageTotals,
      }),
    );
  const since = input.since ? Date.parse(input.since) : Number.NEGATIVE_INFINITY;
  const activity = (item: AgentHistoryEntry) =>
    Date.parse(item.deletedAt ?? item.lastActivityAt ?? item.createdAt);
  return [...fromRecords, ...fromTombstones]
    .filter((item) => (input.includeInternal ? true : !item.internal))
    .filter((item) => activity(item) >= since)
    .sort((a, b) => activity(b) - activity(a))
    .slice(0, input.limit ?? DEFAULT_LIMIT);
}
