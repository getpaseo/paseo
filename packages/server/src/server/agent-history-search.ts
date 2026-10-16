import type {
  AgentMessagePreview,
  AgentSnapshotPayload,
  ProjectPlacementPayload,
} from "@getpaseo/protocol/messages";
import { scoreTextFields, tokenizeQuery } from "@getpaseo/protocol/search/text-match";
import { messagePreviewSnippet } from "./agent/message-preview.js";

export interface AgentHistorySearchCandidate {
  agent: AgentSnapshotPayload;
  project: ProjectPlacementPayload;
  /**
   * The newest messages the daemon kept for this agent, oldest first. Absent for
   * records written before it kept any, and for agents that never spoke.
   */
  previewMessages?: readonly AgentMessagePreview[];
}

export interface AgentHistorySearchMatch {
  matched: boolean;
  /**
   * The message that put the row in the list, or null when the names alone did.
   * Only one is sent, and only for rows that need the explanation.
   */
  messageSnippet: AgentMessagePreview | null;
}

const NO_MATCH: AgentHistorySearchMatch = { matched: false, messageSnippet: null };

/**
 * Every word must land somewhere: the names people recall (workspace, title,
 * branch, project) or one of the stored messages. Names stay typo tolerant;
 * text inside a conversation has to be a literal run of characters, because a
 * fuzzy match over a paragraph matches almost any word.
 */
export function matchAgentHistoryQuery(
  query: string,
  { agent, project, previewMessages }: AgentHistorySearchCandidate,
): AgentHistorySearchMatch {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) {
    // Callers drop blank searches before they get here; keeping every candidate
    // for one is the behaviour this matcher has always had.
    return { matched: true, messageSnippet: null };
  }

  const names = [
    project.workspaceName ?? "",
    agent.title ?? "",
    project.checkout.currentBranch ?? "",
    project.projectName,
  ];
  const previewText = previewMessages?.length
    ? previewMessages
        .map((message) => message.text)
        .join(" ")
        .toLowerCase()
    : "";

  let matchedInMessages = false;
  // Only the words a message had to carry pick the snippet: a word the title
  // already explains would otherwise choose a row that then hides the word
  // which actually made the message necessary.
  const messageTokens: string[] = [];
  for (const token of tokens) {
    if (scoreTextFields(token, names, { typoTolerant: true }) !== null) {
      continue;
    }
    if (!previewText.includes(token)) {
      return NO_MATCH;
    }
    matchedInMessages = true;
    messageTokens.push(token);
  }

  if (!matchedInMessages) {
    return { matched: true, messageSnippet: null };
  }
  return {
    matched: true,
    messageSnippet: messagePreviewSnippet(messageTokens, previewMessages ?? []),
  };
}
