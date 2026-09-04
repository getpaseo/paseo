import type { ProviderTimelineItem } from "@getpaseo/plugin/provider";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { limitAgentTimelineItemContent } from "./agent-timeline-content.js";
import type { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

interface SnapshotEntry {
  rowSeq?: number;
  snapshot?: ProviderTimelineItem;
}

export interface ProviderTimelineReduction {
  row: AgentTimelineRow;
  compatibilityItem: AgentTimelineItem | null;
  newlyCompletedTool: boolean;
}

interface ProviderTimelineReducerOptions {
  append(sessionId: string, row: AgentTimelineRow): void;
  update(sessionId: string, row: AgentTimelineRow): void;
}

interface RevertMetadata {
  hasToken: boolean;
  token?: JsonValue;
}

/** Owns stable provider item identity before the legacy stream projection. */
export class ProviderTimelineReducer {
  private readonly sessions = new Map<string, Map<string, SnapshotEntry>>();

  constructor(
    private readonly store: InMemoryAgentTimelineStore,
    private readonly persistence: ProviderTimelineReducerOptions,
  ) {}

  restore(sessionId: string, rows: readonly AgentTimelineRow[], rowsAreLoaded: boolean): void {
    const entries = this.entries(sessionId);
    for (const row of rows) {
      if (!row.providerTimelineItemId) continue;
      entries.set(row.providerTimelineItemId, {
        ...(rowsAreLoaded ? { rowSeq: row.seq } : {}),
        snapshot: restoreSnapshot(row),
      });
    }
  }

  reset(sessionId: string): void {
    const entries = this.sessions.get(sessionId);
    if (!entries) return;
    entries.clear();
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  accept(input: {
    sessionId: string;
    item: ProviderTimelineItem;
    timestamp?: string;
    turnId?: string;
  }): ProviderTimelineReduction {
    const entries = this.entries(input.sessionId);
    const previous = entries.get(input.item.id);
    const revert = resolveRevertMetadata(input.item);
    const existingRow = this.existingRow(input.sessionId, input.item, previous);
    const reconciledSubmittedPrompt = reconcilesSubmittedPrompt(previous, existingRow, input.item);
    const item = publicItem(input.item, existingRow);
    const rowOptions = providerRowOptions(input, revert);
    const isRevision = previous?.rowSeq !== undefined && existingRow != null;
    let row: AgentTimelineRow | null;
    if (isRevision || !existingRow) {
      row = this.store.append(input.sessionId, item, rowOptions);
    } else {
      row = this.store.replace(input.sessionId, existingRow.seq, item, rowOptions);
    }
    if (!row) throw new Error(`Provider timeline row ${existingRow?.seq ?? "unknown"} disappeared`);
    if (isRevision || !existingRow) this.persistence.append(input.sessionId, row);
    else this.persistence.update(input.sessionId, row);
    entries.set(input.item.id, {
      rowSeq: row.seq,
      snapshot: input.item,
    });
    return {
      row,
      compatibilityItem: reconciledSubmittedPrompt
        ? null
        : compatibilityItem(previous?.snapshot, input.item, item),
      newlyCompletedTool: isNewlyCompletedTool(previous?.snapshot, input.item),
    };
  }

  private entries(sessionId: string): Map<string, SnapshotEntry> {
    let entries = this.sessions.get(sessionId);
    if (!entries) {
      entries = new Map();
      this.sessions.set(sessionId, entries);
    }
    return entries;
  }

  private optimisticRow(sessionId: string, item: ProviderTimelineItem): AgentTimelineRow | null {
    if (item.type !== "user_message" || !item.clientMessageId) return null;
    return this.store.getSubmittedUserMessage(sessionId, item.clientMessageId);
  }

  private existingRow(
    sessionId: string,
    item: ProviderTimelineItem,
    previous: SnapshotEntry | undefined,
  ): AgentTimelineRow | null | undefined {
    if (previous?.rowSeq === undefined) return this.optimisticRow(sessionId, item);
    return this.store.getRows(sessionId).find((row) => row.seq === previous.rowSeq);
  }
}

function resolveRevertMetadata(item: ProviderTimelineItem): RevertMetadata {
  if ("revertToken" in item) return { hasToken: true, token: item.revertToken };
  return { hasToken: false };
}

function providerRowOptions(
  input: {
    item: ProviderTimelineItem;
    timestamp?: string;
    turnId?: string;
  },
  revert: RevertMetadata,
) {
  return {
    timestamp: input.timestamp,
    turnId: input.turnId,
    providerTimelineItemId: input.item.id,
    ...(input.item.type === "user_message" && input.item.messageId
      ? { providerMessageId: input.item.messageId }
      : {}),
    ...(revert.hasToken ? { revertToken: revert.token } : {}),
  };
}

function reconcilesSubmittedPrompt(
  previous: SnapshotEntry | undefined,
  row: AgentTimelineRow | null | undefined,
  item: ProviderTimelineItem,
): boolean {
  return (
    previous === undefined && row?.item.type === "user_message" && item.type === "user_message"
  );
}

function isNewlyCompletedTool(
  previous: ProviderTimelineItem | undefined,
  current: ProviderTimelineItem,
): boolean {
  return (
    current.type === "tool_call" &&
    current.status === "completed" &&
    !(previous?.type === "tool_call" && previous.status === "completed")
  );
}

function publicItem(
  item: ProviderTimelineItem,
  existingRow: AgentTimelineRow | null | undefined,
): AgentTimelineItem {
  const { revertToken: _revertToken, ...withoutToken } = item;
  if (withoutToken.type === "plugin") return limitAgentTimelineItemContent(withoutToken);
  const { id: _id, ...timelineItem } = withoutToken;
  if (timelineItem.type === "user_message" && existingRow?.item.type === "user_message") {
    return limitAgentTimelineItemContent({
      ...timelineItem,
      clientMessageId: existingRow.item.clientMessageId ?? timelineItem.clientMessageId,
      messageId: existingRow.item.messageId ?? timelineItem.messageId,
    });
  }
  return limitAgentTimelineItemContent(timelineItem as AgentTimelineItem);
}

function restoreSnapshot(row: AgentTimelineRow): ProviderTimelineItem {
  return {
    ...row.item,
    id: row.providerTimelineItemId!,
    ...(row.revertToken !== undefined ? { revertToken: row.revertToken } : {}),
  } as ProviderTimelineItem;
}

function compatibilityItem(
  previous: ProviderTimelineItem | undefined,
  current: ProviderTimelineItem,
  publicCurrent: AgentTimelineItem,
): AgentTimelineItem | null {
  if (!previous) return withCompatibilityIdentity(publicCurrent, current.id);
  if (
    (current.type === "assistant_message" || current.type === "reasoning") &&
    previous.type === current.type &&
    current.text.startsWith(previous.text)
  ) {
    const text = current.text.slice(previous.text.length);
    if (text.length === 0) return null;
    return withCompatibilityIdentity({ ...publicCurrent, text } as AgentTimelineItem, current.id);
  }
  return withCompatibilityIdentity(publicCurrent, current.id);
}

function withCompatibilityIdentity(item: AgentTimelineItem, id: string): AgentTimelineItem {
  if (item.type === "assistant_message" && !item.messageId) return { ...item, messageId: id };
  return item;
}
