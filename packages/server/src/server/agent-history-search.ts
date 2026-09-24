import type { AgentSnapshotPayload, ProjectPlacementPayload } from "@getpaseo/protocol/messages";
import { scoreTextFields, tokenizeQuery } from "@getpaseo/protocol/search/text-match";
import {
  emptyHistoryConversation,
  type HistoryContentSource,
  type HistoryConversation,
} from "./agent-history-content.js";

export interface AgentHistorySearchCandidate {
  agent: AgentSnapshotPayload;
  project: ProjectPlacementPayload;
  /** Older callers pass one string. It is treated as the assistant reply. */
  content?: string;
  conversation?: HistoryConversation | null;
}

/**
 * Search the names people recall and the persisted conversation.
 * A token may land in a name or in the message text. Names keep typo
 * tolerance. Message text is a direct substring, so a long transcript is
 * not fuzzy-scanned.
 *
 * A name, a user message, or a reply outranks thinking and tool traces.
 * Thinking and tools still match.
 */
export function matchesAgentHistoryQuery(
  query: string,
  candidate: AgentHistorySearchCandidate,
): boolean {
  if (tokenizeQuery(query).length === 0) return true;
  return agentHistoryMatchBand(query, candidate) !== null;
}

/** 0 when every token is in a name, user message, or reply. 1 when a token is only in thinking or a tool. Null when nothing matches. */
export function agentHistoryMatchBand(
  query: string,
  candidate: AgentHistorySearchCandidate,
): 0 | 1 | null {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return 0;
  const names = [
    candidate.project.workspaceName ?? "",
    candidate.agent.title ?? "",
    candidate.project.checkout.currentBranch ?? "",
    candidate.project.projectName,
  ];
  const conversation = conversationOf(candidate);
  const user = conversation.user.toLowerCase();
  const reply = conversation.reply.toLowerCase();
  const thinking = conversation.thinking.toLowerCase();
  const tool = conversation.tool.toLowerCase();
  let traceOnly = false;
  for (const token of tokens) {
    if (scoreTextFields(token, names, { typoTolerant: true }) !== null) continue;
    if (user.includes(token) || reply.includes(token)) continue;
    if (thinking.includes(token) || tool.includes(token)) {
      traceOnly = true;
      continue;
    }
    return null;
  }
  return traceOnly ? 1 : 0;
}

export interface HistoryContentHit {
  snippet: string;
  source: HistoryContentSource;
}

const SOURCE_PREFERENCE: readonly HistoryContentSource[] = ["user", "reply", "thinking", "tool"];

/** The excerpt comes from the best place that contains the query, not the first byte of a flattened transcript. */
export function historyContentHit(
  query: string,
  conversation: HistoryConversation,
): HistoryContentHit | null {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return null;
  let best: { source: HistoryContentSource; count: number; preference: number } | null = null;
  SOURCE_PREFERENCE.forEach((source, preference) => {
    const lower = conversation[source].toLowerCase();
    let count = 0;
    for (const token of tokens) {
      if (lower.includes(token)) count += 1;
    }
    if (count === 0) return;
    if (!best || count > best.count || (count === best.count && preference < best.preference)) {
      best = { source, count, preference };
    }
  });
  if (!best) return null;
  const snippet = historyContentSnippet(query, conversation[best.source]);
  if (!snippet) return null;
  return { snippet, source: best.source };
}

/** A short line of one band around the words that matched. */
export function historyContentSnippet(query: string, content: string): string | null {
  const tokens = tokenizeQuery(query);
  if (!content || tokens.length === 0) return null;
  const lower = content.toLowerCase();
  const parts: string[] = [];
  for (const token of tokens) {
    const at = lower.indexOf(token);
    if (at < 0) continue;
    const start = Math.max(0, at - 36);
    const end = Math.min(content.length, at + token.length + 36);
    let slice = content.slice(start, end).replace(/\s+/g, " ").trim();
    if (start > 0) slice = `…${slice}`;
    if (end < content.length) slice = `${slice}…`;
    parts.push(slice);
  }
  if (parts.length === 0) return null;
  const joined = parts.join(" · ");
  return joined.length > 180 ? `${joined.slice(0, 179)}…` : joined;
}

/** Message and name hits stay above thinking and tool hits. Recency order inside a band is preserved. */
export function orderHistoryMatchesByBand<
  T extends { contentMatchBand?: "message" | "trace" | null },
>(entries: readonly T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const band =
        (left.entry.contentMatchBand === "trace" ? 1 : 0) -
        (right.entry.contentMatchBand === "trace" ? 1 : 0);
      return band || left.index - right.index;
    })
    .map((item) => item.entry);
}

function conversationOf(candidate: AgentHistorySearchCandidate): HistoryConversation {
  if (candidate.conversation) return candidate.conversation;
  if (candidate.content) {
    return { user: "", reply: candidate.content, thinking: "", tool: "" };
  }
  return emptyHistoryConversation();
}
