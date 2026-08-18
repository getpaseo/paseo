import { isDeepStrictEqual } from "node:util";

import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

export interface ProviderHistoryTimelineEntry {
  item: AgentTimelineItem;
  timestamp?: string;
}

/** Reconciles canonical metadata onto provider-ordered history without inventing membership. */
export function reconcileProviderHistory(
  canonicalRows: readonly AgentTimelineRow[],
  providerEntries: readonly ProviderHistoryTimelineEntry[],
  options?: { mode?: "incomplete" | "force" },
): AgentTimelineRow[] {
  if (providerEntries.length === 0) {
    return options?.mode === "force"
      ? []
      : canonicalRows.map((row, index) => ({ ...row, seq: index + 1 }));
  }
  const remaining = canonicalRows.map((row, canonicalIndex) => ({
    row,
    canonicalIndex,
    used: false,
  }));
  const structuralCounts = countStructuralOccurrences(canonicalRows, providerEntries);
  const providerRows = providerEntries.map((entry) => {
    const match = takeMatch(remaining, entry.item, structuralCounts);
    return { entry, match };
  });
  const rows: AgentTimelineRow[] = [];
  const emittedCanonicalIndexes = new Set<number>();

  for (const { entry, match } of providerRows) {
    if (match) {
      for (const candidate of remaining) {
        if (candidate.canonicalIndex >= match.canonicalIndex) break;
        if (!emittedCanonicalIndexes.has(candidate.canonicalIndex)) {
          rows.push({ ...candidate.row });
          emittedCanonicalIndexes.add(candidate.canonicalIndex);
        }
      }
      rows.push(
        match.transferProviderIdentity ? mergeMatchedRow(match.row, entry) : { ...match.row },
      );
      emittedCanonicalIndexes.add(match.canonicalIndex);
      continue;
    }
    rows.push({
      seq: 0,
      timestamp: entry.timestamp ?? new Date(0).toISOString(),
      item: entry.item,
    });
  }

  if (options?.mode !== "force") {
    for (const candidate of remaining) {
      if (!emittedCanonicalIndexes.has(candidate.canonicalIndex)) {
        rows.push({ ...candidate.row });
      }
    }
  }
  rows.forEach((row, index) => {
    row.seq = index + 1;
  });
  return rows;
}

function takeMatch(
  remaining: Array<{ row: AgentTimelineRow; canonicalIndex: number; used: boolean }>,
  provider: AgentTimelineItem,
  structuralCounts: Map<string, { canonical: number; provider: number }>,
): { row: AgentTimelineRow; canonicalIndex: number; transferProviderIdentity: boolean } | null {
  const strong = remaining.find(
    (candidate) => !candidate.used && hasSharedIdentity(candidate.row, provider),
  );
  const structural =
    strong ??
    remaining.find(
      (candidate) => !candidate.used && structurallyMatches(candidate.row.item, provider),
    );
  if (!structural) return null;
  structural.used = true;
  const key = structuralKey(provider);
  const counts = structuralCounts.get(key);
  return {
    row: structural.row,
    canonicalIndex: structural.canonicalIndex,
    transferProviderIdentity:
      strong !== undefined || (counts?.canonical === 1 && counts.provider === 1),
  };
}

function mergeMatchedRow(
  canonical: AgentTimelineRow,
  provider: ProviderHistoryTimelineEntry,
): AgentTimelineRow {
  return {
    ...canonical,
    item: mergeCanonicalIdentity(canonical.item, provider.item),
  };
}

function countStructuralOccurrences(
  canonicalRows: readonly AgentTimelineRow[],
  providerEntries: readonly ProviderHistoryTimelineEntry[],
): Map<string, { canonical: number; provider: number }> {
  const counts = new Map<string, { canonical: number; provider: number }>();
  for (const row of canonicalRows) {
    const key = structuralKey(row.item);
    const count = counts.get(key) ?? { canonical: 0, provider: 0 };
    count.canonical += 1;
    counts.set(key, count);
  }
  for (const entry of providerEntries) {
    const key = structuralKey(entry.item);
    const count = counts.get(key) ?? { canonical: 0, provider: 0 };
    count.provider += 1;
    counts.set(key, count);
  }
  return counts;
}

function structuralKey(item: AgentTimelineItem): string {
  return item.type === "user_message"
    ? `user:${item.text}`
    : `${item.type}:${JSON.stringify(item)}`;
}

function hasSharedIdentity(row: AgentTimelineRow, provider: AgentTimelineItem): boolean {
  if (row.item.type !== "user_message" || provider.type !== "user_message") return false;
  const identities = [row.item.clientMessageId, row.item.messageId, row.providerMessageId].filter(
    Boolean,
  );
  return identities.some(
    (identity) => identity === provider.clientMessageId || identity === provider.messageId,
  );
}

function structurallyMatches(left: AgentTimelineItem, right: AgentTimelineItem): boolean {
  if (left.type === "user_message" && right.type === "user_message")
    return left.text === right.text;
  return isDeepStrictEqual(left, right);
}

function mergeCanonicalIdentity(
  canonical: AgentTimelineItem,
  provider: AgentTimelineItem,
): AgentTimelineItem {
  if (canonical.type !== "user_message" || provider.type !== "user_message") return provider;
  return {
    ...provider,
    ...(canonical.clientMessageId ? { clientMessageId: canonical.clientMessageId } : {}),
    ...(canonical.messageId ? { messageId: canonical.messageId } : {}),
  };
}
