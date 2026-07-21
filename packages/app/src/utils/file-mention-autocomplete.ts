import { isDelegatedAgent } from "@getpaseo/protocol/agent-labels";
import { compareMatchScores, scoreTextFields, type MatchScore } from "./score-match";

export interface FileMentionRange {
  start: number;
  end: number;
  query: string;
}

export interface AgentMentionCandidate {
  id: string;
  title: string | null;
  cwd: string;
  provider: string;
  archivedAt?: Date | null;
  labels: Record<string, string>;
}

interface FindActiveFileMentionInput {
  text: string;
  cursorIndex: number;
}

interface ApplyFileMentionReplacementInput {
  text: string;
  mention: FileMentionRange;
  relativePath: string;
}

interface ApplyAgentMentionReplacementInput {
  text: string;
  mention: FileMentionRange;
}

interface ScoredAgentMentionCandidate<TEntry> {
  entry: TEntry;
  score: MatchScore;
}

const INVALID_MENTION_QUERY_CHARS = /[\s\n\r\t"']/;

export function findActiveFileMention(input: FindActiveFileMentionInput): FileMentionRange | null {
  const clampedCursor = Math.max(0, Math.min(input.cursorIndex, input.text.length));
  const beforeCursor = input.text.slice(0, clampedCursor);

  for (
    let atIndex = beforeCursor.lastIndexOf("@");
    atIndex >= 0;
    atIndex = atIndex === 0 ? -1 : beforeCursor.lastIndexOf("@", atIndex - 1)
  ) {
    const query = beforeCursor.slice(atIndex + 1);
    if (INVALID_MENTION_QUERY_CHARS.test(query)) {
      continue;
    }
    return {
      start: atIndex,
      end: clampedCursor,
      query,
    };
  }

  return null;
}

export function formatQuotedFileMentionPath(relativePath: string): string {
  const safePath = relativePath.replace(/"/g, '\\"');
  return `"${safePath}"`;
}

export function applyFileMentionReplacement(input: ApplyFileMentionReplacementInput): string {
  const before = input.text.slice(0, input.mention.start);
  const after = input.text.slice(input.mention.end);
  return `${before}${formatQuotedFileMentionPath(input.relativePath)}${after}`;
}

export function applyAgentMentionReplacement(input: ApplyAgentMentionReplacementInput): string {
  let before = input.text.slice(0, input.mention.start);
  let after = input.text.slice(input.mention.end);
  if (!before && /^\s/.test(after)) {
    after = after.slice(1);
  } else if (!after && /\s$/.test(before)) {
    before = before.slice(0, -1);
  } else if (/\s$/.test(before) && /^\s/.test(after)) {
    after = after.slice(1);
  }
  return `${before}${after}`;
}

function scoreAgentMentionCandidate(
  candidate: AgentMentionCandidate,
  query: string,
): MatchScore | null {
  return scoreTextFields(query, [candidate.title ?? "", candidate.cwd, candidate.id]);
}

export function filterAndRankAgentMentionCandidates<TEntry extends AgentMentionCandidate>(
  candidates: readonly TEntry[],
  query: string,
  currentAgentId: string,
): TEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  const candidateIds = new Set<string>();
  const eligibleCandidates = candidates.filter((candidate) => {
    if (
      candidate.id === currentAgentId ||
      (candidate.archivedAt !== null && candidate.archivedAt !== undefined) ||
      isDelegatedAgent(candidate) ||
      candidateIds.has(candidate.id)
    ) {
      return false;
    }
    candidateIds.add(candidate.id);
    return true;
  });

  if (normalizedQuery.length === 0) {
    return eligibleCandidates;
  }

  const scoredCandidates: ScoredAgentMentionCandidate<TEntry>[] = [];
  for (const candidate of eligibleCandidates) {
    const score = scoreAgentMentionCandidate(candidate, normalizedQuery);
    if (score) {
      scoredCandidates.push({ entry: candidate, score });
    }
  }

  scoredCandidates.sort((left, right) => {
    const scoreComparison = compareMatchScores(left.score, right.score);
    if (scoreComparison !== 0) {
      return scoreComparison;
    }
    return (left.entry.title ?? left.entry.id).localeCompare(right.entry.title ?? right.entry.id);
  });

  return scoredCandidates.map((candidate) => candidate.entry);
}
