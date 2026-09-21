import { randomUUID } from "node:crypto";
import type { CompanionEntry } from "@getpaseo/protocol/companion-stream";
import type { AgentPermissionRequest, AgentStreamEvent } from "./agent-sdk-types.js";

export const COMPANION_ENTRY_LIMIT = 50;
export const COMPANION_TEXT_LIMIT = 4000;

interface ResponseDraft {
  text: string;
  messageId: string | undefined;
  truncated: boolean;
}

function excerpt(text: string): { text: string; truncated: boolean } {
  return {
    text: text.slice(0, COMPANION_TEXT_LIMIT),
    truncated: text.length > COMPANION_TEXT_LIMIT,
  };
}

function requestText(request: AgentPermissionRequest): string {
  const questions = request.input?.questions;
  if (Array.isArray(questions)) {
    const text = questions
      .flatMap((question: unknown) => {
        if (typeof question !== "object" || question === null || !("question" in question))
          return [];
        return typeof question.question === "string" ? [question.question] : [];
      })
      .join("\n\n");
    if (text) return text;
  }
  if (request.kind === "plan") {
    if (typeof request.metadata?.planText === "string") return request.metadata.planText;
    if (typeof request.input?.plan === "string") return request.input.plan;
  }
  if (request.detail?.type === "plain_text" && request.detail.text) return request.detail.text;
  if (request.detail?.type === "plan") return request.detail.text;
  if (request.detail?.type === "shell") return request.detail.command;
  return request.description || request.title || request.name;
}

export function restoreCompanionEntries(options?: {
  companionEntries?: CompanionEntry[];
}): CompanionEntry[] {
  const entries = options?.companionEntries ?? [];
  // Provider requests do not survive session recreation. Do not present an old approval as live.
  return entries.map(expirePendingPermission);
}

function expirePendingPermission(entry: CompanionEntry): CompanionEntry {
  return entry.kind === "permission" && entry.status === "pending"
    ? { ...entry, status: "expired" }
    : entry;
}

export class CompanionStreamCollector {
  private readonly drafts = new Map<string, Map<string, ResponseDraft>>();

  clear(agentId: string): void {
    this.drafts.delete(agentId);
  }

  observe(
    agentId: string,
    entries: CompanionEntry[],
    event: AgentStreamEvent,
    timestamp: string,
  ): CompanionEntry[] {
    const turnKey = "turnId" in event ? (event.turnId ?? "unscoped") : "unscoped";
    const turns = this.drafts.get(agentId) ?? new Map<string, ResponseDraft>();
    if (event.type === "turn_started") {
      turns.delete(turnKey);
      this.drafts.set(agentId, turns);
    }
    if (event.type === "timeline") {
      return this.observeTimeline(agentId, entries, event, turnKey, turns);
    }
    if (event.type === "permission_requested") {
      const entry: CompanionEntry = {
        id: `permission:${event.request.id}`,
        kind: "permission",
        timestamp,
        requestId: event.request.id,
        requestKind: event.request.kind,
        status: "pending",
        ...excerpt(requestText(event.request)),
      };
      return upsert(entries, entry);
    }
    if (event.type === "permission_resolved") {
      return entries.map((entry) =>
        entry.kind === "permission" && entry.requestId === event.requestId
          ? { ...entry, status: event.resolution.behavior === "allow" ? "allowed" : "denied" }
          : entry,
      );
    }
    if (
      event.type !== "turn_completed" &&
      event.type !== "turn_failed" &&
      event.type !== "turn_canceled"
    )
      return entries;

    const draft = turns.get(turnKey);
    turns.delete(turnKey);
    if (turns.size === 0) this.drafts.delete(agentId);
    return collectOutcome(entries, event, timestamp, draft);
  }

  private observeTimeline(
    agentId: string,
    entries: CompanionEntry[],
    event: Extract<AgentStreamEvent, { type: "timeline" }>,
    turnKey: string,
    turns: Map<string, ResponseDraft>,
  ): CompanionEntry[] {
    const item = event.item;
    if (item.type === "assistant_message") {
      const previous = turns.get(turnKey);
      const sameMessage = previous && previous.messageId === item.messageId;
      const next = excerpt((sameMessage ? previous.text : "") + item.text);
      turns.set(turnKey, {
        ...next,
        messageId: item.messageId,
        truncated: next.truncated || Boolean(sameMessage && previous.truncated),
      });
      this.drafts.set(agentId, turns);
    } else if (item.type === "tool_call" || item.type === "user_message") {
      // Only the final response is a review card, not intermediate tool narration.
      turns.delete(turnKey);
    }
    if (item.type === "user_message") {
      return entries.map((entry) =>
        entry.kind === "question" && entry.status === "open"
          ? { ...entry, status: "reply_sent" }
          : entry,
      );
    }
    return entries;
  }
}

function collectOutcome(
  entries: CompanionEntry[],
  event: Extract<AgentStreamEvent, { type: "turn_completed" | "turn_failed" | "turn_canceled" }>,
  timestamp: string,
  draft: ResponseDraft | undefined,
): CompanionEntry[] {
  const id = `turn:${event.turnId ?? randomUUID()}`;
  if (entries.some((entry) => entry.id === id)) return entries;
  let next = entries;
  if (event.type !== "turn_completed") {
    next = next.map(expirePendingPermission);
  }
  const text = draft?.text.trim() ?? "";
  // Plain prose questions are a hint, never a claim that a later reply resolved a decision.
  const prose = text.replace(/```[\s\S]*?```|`[^`]*`|https?:\/\/\S+/g, "");
  const question = event.type === "turn_completed" && /[?？]\s*$/.test(prose);
  if (question) {
    next = upsert(next, {
      id: `${id}:question`,
      kind: "question",
      timestamp,
      text,
      truncated: draft?.truncated ?? false,
      status: "open",
    });
  }
  let outcomeText = question ? "" : text;
  let status: "completed" | "failed" | "canceled" = "completed";
  if (event.type === "turn_failed") {
    outcomeText = event.error;
    status = "failed";
  } else if (event.type === "turn_canceled") {
    outcomeText = event.reason;
    status = "canceled";
  }
  return upsert(next, {
    id,
    kind: "outcome",
    timestamp,
    ...excerpt(outcomeText),
    truncated:
      outcomeText === text
        ? (draft?.truncated ?? false)
        : outcomeText.length > COMPANION_TEXT_LIMIT,
    status,
  });
}

function upsert(entries: CompanionEntry[], entry: CompanionEntry): CompanionEntry[] {
  const existing = entries.find((item) => item.id === entry.id);
  const next = existing
    ? entries.map((item) => (item.id === entry.id ? { ...entry, timestamp: item.timestamp } : item))
    : [...entries, entry];
  return next.slice(-COMPANION_ENTRY_LIMIT);
}
