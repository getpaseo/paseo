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
  const remaining = canonicalRows.map((row) => ({ row, used: false }));
  return providerEntries.map((entry, index) => {
    const matched = takeMatch(remaining, entry.item);
    if (!matched) {
      return {
        seq: index + 1,
        timestamp: entry.timestamp ?? new Date(0).toISOString(),
        item: entry.item,
      };
    }
    return {
      seq: index + 1,
      timestamp: matched.timestamp,
      item: mergeCanonicalIdentity(matched.item, entry.item),
      ...(matched.turnId ? { turnId: matched.turnId } : {}),
      ...(matched.providerMessageId ? { providerMessageId: matched.providerMessageId } : {}),
    };
  });
}

function takeMatch(
  remaining: Array<{ row: AgentTimelineRow; used: boolean }>,
  provider: AgentTimelineItem,
): AgentTimelineRow | null {
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
  return structural.row;
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
