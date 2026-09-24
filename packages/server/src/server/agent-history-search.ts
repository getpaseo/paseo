import type { AgentSnapshotPayload, ProjectPlacementPayload } from "@getpaseo/protocol/messages";
import { scoreTextFields, tokenizeQuery } from "@getpaseo/protocol/search/text-match";

export interface AgentHistorySearchCandidate {
  agent: AgentSnapshotPayload;
  project: ProjectPlacementPayload;
  /** Persisted user and assistant text. Not the on-screen message window. */
  content?: string;
}

/**
 * Search the names people recall and the persisted conversation.
 * A token may land in a name or in the message text. Names keep typo
 * tolerance. Message text is a direct substring, so a long transcript is
 * not fuzzy-scanned.
 */
export function matchesAgentHistoryQuery(
  query: string,
  { agent, project, content }: AgentHistorySearchCandidate,
): boolean {
  const names = [
    project.workspaceName ?? "",
    agent.title ?? "",
    project.checkout.currentBranch ?? "",
    project.projectName,
  ];
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return true;
  const body = (content ?? "").toLowerCase();
  for (const token of tokens) {
    if (scoreTextFields(token, names, { typoTolerant: true }) !== null) continue;
    if (body.includes(token)) continue;
    return false;
  }
  return true;
}

/** A short line of the conversation around the words that matched. */
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
