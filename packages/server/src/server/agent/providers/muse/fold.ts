import { ItemStore } from "@muse-code/sdk";

import type {
  AgentProvider,
  AgentStreamEvent,
  AgentTimelineItem,
  AgentUsage,
} from "../../agent-sdk-types.js";
import type { MuseHostNotification } from "./host.js";
import { asMuseViewItem, isRecord, type MuseViewItem } from "./items.js";
import { mapMuseSubagentEvents } from "./subagents.js";
import { mapMuseToolCall } from "./tools.js";

export interface MuseFoldCallbacks {
  onEvent(event: AgentStreamEvent): void;
  /**
   * Resolve the Paseo client message id for a live user-message echo, or null
   * when the item is not the foreground submission. History mapping never
   * attaches a client id.
   */
  resolveEchoClientMessageId?(item: MuseViewItem): string | null;
  onUsagePartial?(usage: AgentUsage): void;
  onDebug?(message: string, data?: unknown): void;
}

/**
 * Folds MSP view notifications into Paseo stream events. Item revision and
 * delta accumulation ride the SDK's `ItemStore`; turn lifecycle, echo
 * correlation, and terminalization are owned here.
 */
export class MuseNotificationFold {
  private readonly items = new ItemStore<MuseViewItem>();
  private readonly streamedFields = new Set<string>();
  private readonly echoedUserItems = new Set<string>();

  constructor(
    private readonly provider: AgentProvider,
    private readonly callbacks: MuseFoldCallbacks,
  ) {}

  apply(notification: MuseHostNotification): void {
    switch (notification.method) {
      case "item/started":
      case "item/updated":
      case "item/completed":
        this.applyItemFrame(notification.method, notification.params);
        return;
      case "item/delta":
        this.applyDelta(notification.params);
        return;
      case "turn/started":
        this.callbacks.onEvent({
          type: "turn_started",
          provider: this.provider,
          ...(typeof notification.params["turnId"] === "string"
            ? { turnId: notification.params["turnId"] }
            : {}),
        });
        return;
      case "turn/completed":
        this.applyTurnCompleted(notification.params);
        return;
      case "session/tokenUsage":
        this.applyTokenUsage(notification.params);
        return;
      case "session/contextUsage":
        this.applyContextUsage(notification.params);
        return;
      default:
        return;
    }
  }

  /** Folded items in first-opened order, for history hydration. */
  listItems(): readonly MuseViewItem[] {
    return this.items.list();
  }

  /** Drop all folded state after the session rebinds to a forked native session. */
  reset(): void {
    this.items.seed([]);
    this.streamedFields.clear();
    this.echoedUserItems.clear();
  }

  private applyItemFrame(method: string, params: Record<string, unknown>): void {
    const item = asMuseViewItem(params["item"]);
    if (!item) {
      this.callbacks.onDebug?.(`Ignoring ${method} with an unparseable item`);
      return;
    }
    const outcome = this.items.apply(item);
    if (outcome.kind === "ignoredStaleRevision") {
      return;
    }
    if (item.kind === "subagent" || item.kind === "reminderChild" || item.kind === "workflow") {
      for (const event of mapMuseSubagentEvents(item, this.provider, {
        terminal: method === "item/completed",
      })) {
        this.callbacks.onEvent(event);
      }
      return;
    }
    const turnId = typeof item.turnId === "string" ? item.turnId : undefined;
    if (method === "item/started") {
      this.emitItemOpened(item, turnId);
      return;
    }
    if (method === "item/updated") {
      this.emitItemUpdated(item, turnId);
      return;
    }
    this.emitItemCompleted(item, turnId);
  }

  private applyDelta(params: Record<string, unknown>): void {
    const itemId = params["itemId"];
    const delta = params["delta"];
    if (typeof itemId !== "string" || typeof delta !== "string" || delta.length === 0) {
      return;
    }
    const field = typeof params["field"] === "string" ? params["field"] : "text";
    this.items.applyDelta(itemId, delta, field);
    const item = this.items.get(itemId);
    if (item?.kind === "agentMessage" && field === "text") {
      this.streamedFields.add(`${itemId}\ntext`);
      this.emitTimeline(
        { type: "assistant_message", text: delta, messageId: itemId },
        typeof item.turnId === "string" ? item.turnId : undefined,
      );
      return;
    }
    if (item?.kind === "reasoning" && (field === "text" || field.startsWith("summary."))) {
      this.streamedFields.add(`${itemId}\n${field}`);
      this.emitTimeline(
        { type: "reasoning", text: delta },
        typeof item.turnId === "string" ? item.turnId : undefined,
      );
    }
  }

  private emitItemOpened(item: MuseViewItem, turnId: string | undefined): void {
    if (item.kind === "toolCall" || item.kind === "userShell") {
      this.emitTimeline(mapMuseToolCall({ ...item, status: "inProgress" }), turnId);
      return;
    }
    if (item.kind === "compaction") {
      this.emitTimeline({ type: "compaction", status: "loading" }, turnId);
    }
  }

  private emitItemUpdated(item: MuseViewItem, turnId: string | undefined): void {
    if (item.kind === "toolCall" || item.kind === "userShell") {
      this.emitTimeline(mapMuseToolCall({ ...item, status: "inProgress" }), turnId);
    }
  }

  private emitItemCompleted(item: MuseViewItem, turnId: string | undefined): void {
    switch (item.kind) {
      case "agentMessage": {
        if (!this.streamedFields.has(`${item.itemId}\ntext`)) {
          const text = typeof item.text === "string" ? item.text : "";
          if (text.length > 0) {
            this.emitTimeline(
              { type: "assistant_message", text, messageId: item.itemId },
              turnId,
            );
          }
        }
        return;
      }
      case "reasoning": {
        const streamed = [...this.streamedFields].some((key) =>
          key.startsWith(`${item.itemId}\n`),
        );
        if (!streamed) {
          const text = readReasoningText(item);
          if (text.length > 0) {
            this.emitTimeline({ type: "reasoning", text }, turnId);
          }
        }
        return;
      }
      case "userMessage": {
        this.emitUserMessage(item, turnId);
        return;
      }
      case "toolCall":
      case "userShell": {
        this.emitTimeline(mapMuseToolCall(item), turnId);
        return;
      }
      case "compaction": {
        this.emitTimeline({ type: "compaction", status: "completed" }, turnId);
        return;
      }
      default: {
        this.callbacks.onDebug?.(`Ignoring completed item of kind ${String(item.kind)}`, {
          itemId: item.itemId,
        });
      }
    }
  }

  private emitUserMessage(item: MuseViewItem, turnId: string | undefined): void {
    if (this.echoedUserItems.has(item.itemId)) {
      return;
    }
    this.echoedUserItems.add(item.itemId);
    const text =
      (typeof item.displayText === "string" && item.displayText.length > 0
        ? item.displayText
        : typeof item.text === "string"
          ? item.text
          : "") ?? "";
    if (text.length === 0) {
      return;
    }
    const clientMessageId = this.callbacks.resolveEchoClientMessageId?.(item) ?? null;
    this.emitTimeline(
      clientMessageId
        ? { type: "user_message", text, messageId: clientMessageId, clientMessageId }
        : { type: "user_message", text, messageId: item.itemId },
      turnId,
    );
  }

  private applyTurnCompleted(params: Record<string, unknown>): void {
    const turnId = typeof params["turnId"] === "string" ? params["turnId"] : undefined;
    this.terminalizeOpenItems(turnId);
    const terminal = params["terminal"];
    const reason = typeof params["reason"] === "string" ? params["reason"] : undefined;
    if (terminal === "completed") {
      this.callbacks.onEvent({
        type: "turn_completed",
        provider: this.provider,
        ...(turnId ? { turnId } : {}),
        ...(this.readTurnUsage(params) ?? {}),
      });
      return;
    }
    if (terminal === "cancelled") {
      this.callbacks.onEvent({
        type: "turn_canceled",
        provider: this.provider,
        reason: reason ?? "Muse turn was canceled",
        ...(turnId ? { turnId } : {}),
      });
      return;
    }
    if (terminal === "failed") {
      const failure = isRecord(params["error"]) ? params["error"] : undefined;
      const message =
        (failure && typeof failure["message"] === "string" && failure["message"]) ||
        reason ||
        "Muse turn failed";
      this.callbacks.onEvent({
        type: "turn_failed",
        provider: this.provider,
        error: message,
        ...(failure && typeof failure["kind"] === "string" ? { code: failure["kind"] } : {}),
        ...(turnId ? { turnId } : {}),
      });
      return;
    }
    this.callbacks.onEvent({
      type: "turn_failed",
      provider: this.provider,
      error: reason ?? `Muse turn ended with an unknown terminal: ${String(terminal)}`,
      ...(turnId ? { turnId } : {}),
    });
  }

  /** Close every still-open item of the finished turn before its terminal event. */
  private terminalizeOpenItems(turnId: string | undefined): void {
    for (const item of this.items.list()) {
      if (turnId !== undefined && item.turnId !== turnId) {
        continue;
      }
      if (item.status !== "inProgress") {
        continue;
      }
      if (item.kind === "toolCall" || item.kind === "userShell") {
        this.emitTimeline(mapMuseToolCall({ ...item, status: "cancelled" }), turnId);
      } else if (item.kind === "compaction") {
        this.emitTimeline({ type: "compaction", status: "completed" }, turnId);
      } else if (item.kind === "userMessage") {
        this.emitUserMessage(item, turnId);
      }
    }
  }

  private applyTokenUsage(params: Record<string, unknown>): void {
    const cumulative = isRecord(params["cumulative"]) ? params["cumulative"] : undefined;
    if (!cumulative) {
      return;
    }
    const usage: AgentUsage = {};
    if (typeof cumulative["promptTokens"] === "number") {
      usage.inputTokens = cumulative["promptTokens"];
    }
    if (typeof cumulative["outputTokens"] === "number") {
      usage.outputTokens = cumulative["outputTokens"];
    }
    if (Object.keys(usage).length > 0) {
      this.callbacks.onUsagePartial?.(usage);
    }
  }

  private applyContextUsage(params: Record<string, unknown>): void {
    const usage: AgentUsage = {};
    if (typeof params["windowTokens"] === "number") {
      usage.contextWindowMaxTokens = params["windowTokens"];
    }
    if (typeof params["usedTokens"] === "number") {
      usage.contextWindowUsedTokens = params["usedTokens"];
    }
    if (Object.keys(usage).length > 0) {
      this.callbacks.onUsagePartial?.(usage);
    }
  }

  private readTurnUsage(params: Record<string, unknown>): { usage: AgentUsage } | undefined {
    const usageRecord = isRecord(params["usage"]) ? params["usage"] : undefined;
    if (!usageRecord) {
      return undefined;
    }
    const usage: AgentUsage = {};
    if (typeof usageRecord["inputTokens"] === "number") {
      usage.inputTokens = usageRecord["inputTokens"];
    }
    if (typeof usageRecord["outputTokens"] === "number") {
      usage.outputTokens = usageRecord["outputTokens"];
    }
    const cached =
      typeof usageRecord["cachedTokens"] === "number"
        ? usageRecord["cachedTokens"]
        : typeof usageRecord["cacheReadTokens"] === "number"
          ? usageRecord["cacheReadTokens"]
          : undefined;
    if (cached !== undefined) {
      usage.cachedInputTokens = cached;
    }
    return Object.keys(usage).length > 0 ? { usage } : undefined;
  }

  private emitTimeline(item: AgentTimelineItem, turnId: string | undefined): void {
    this.callbacks.onEvent({
      type: "timeline",
      provider: this.provider,
      item,
      ...(turnId ? { turnId } : {}),
    });
  }
}

export function readReasoningText(item: MuseViewItem): string {
  if (typeof item.text === "string" && item.text.length > 0) {
    return item.text;
  }
  if (Array.isArray(item.summary)) {
    return item.summary.filter((entry): entry is string => typeof entry === "string").join("\n\n");
  }
  return "";
}
