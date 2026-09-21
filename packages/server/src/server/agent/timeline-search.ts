import { projectTimelineRows } from "./timeline-projection.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

export interface TimelineSearchMatchOccurrence {
  startOffset: number;
  endOffset: number;
}

export interface TimelineSearchMatch {
  seq: number;
  epoch: string;
  kind: "user" | "assistant";
  snippet: string;
  occurrences: TimelineSearchMatchOccurrence[];
}

export interface TimelineSearchResult {
  matches: TimelineSearchMatch[];
  continuation: string | null;
  isComplete: boolean;
}

export function searchTimeline(
  rows: readonly AgentTimelineRow[],
  query: string,
  continuation?: string | null,
  limit: number = 20,
): TimelineSearchResult {
  if (!query || query.trim() === "") {
    return { matches: [], continuation: null, isComplete: true };
  }

  const projected = projectTimelineRows({ rows, mode: "projected" });

  // Start from the most recent (tail) or from continuation
  // Wait, chronological or reverse chronological?
  // Usually searches are reverse chronological or just forward. Let's do reverse chronological (newest first).
  // continuation can be the index in projected array.

  let startIndex = projected.length - 1;
  if (continuation) {
    const parsed = parseInt(continuation, 10);
    if (!isNaN(parsed)) {
      startIndex = parsed;
    }
  }

  const lowerQuery = query.toLowerCase();
  const matches: TimelineSearchMatch[] = [];

  let i = startIndex;
  for (; i >= 0; i--) {
    const entry = projected[i];
    if (!entry) continue;

    const { item, seqStart } = entry;

    let textToSearch = "";
    let kind: "user" | "assistant" | null = null;

    if (item.type === "user_message") {
      textToSearch = item.text || "";
      kind = "user";
    } else if (item.type === "assistant_message") {
      textToSearch = item.text || "";
      kind = "assistant";
    }

    if (kind && textToSearch) {
      const occurrences: TimelineSearchMatchOccurrence[] = [];
      let currentOffset = 0;
      const lowerText = textToSearch.toLowerCase();

      while (currentOffset < lowerText.length) {
        const index = lowerText.indexOf(lowerQuery, currentOffset);
        if (index === -1) break;

        occurrences.push({
          startOffset: index,
          endOffset: index + lowerQuery.length,
        });
        currentOffset = index + lowerQuery.length;
      }

      if (occurrences.length > 0) {
        // Snippet logic: for simplicity we can return the whole text right now, or truncate if it's too long.
        // Let's just return the full text as the snippet for now to ensure offsets are trivially correct.
        matches.push({
          seq: seqStart,
          epoch: "", // We will fill this in agent-manager
          kind,
          snippet: textToSearch,
          occurrences,
        });

        if (matches.length >= limit) {
          break;
        }
      }
    }
  }

  const isComplete = i < 0;
  const nextContinuation = isComplete ? null : (i - 1).toString();

  return {
    matches,
    continuation: nextContinuation,
    isComplete,
  };
}
