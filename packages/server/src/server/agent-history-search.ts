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
