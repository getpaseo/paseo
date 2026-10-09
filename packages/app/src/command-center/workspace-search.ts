import {
  compareCommandCenterScores,
  filterAndRankBuiltInResults,
  scoreSearchFields,
  type CommandCenterScore,
  type CommandCenterWorkspaceResult,
} from "./results";

/** A change-request query: an optional `pr`/`mr` word, an optional `#`/`!`, a number. */
const CHANGE_REQUEST_QUERY = /^(?:(?:pr|mr)\s*)?[#!]?(\d+)$/i;

/**
 * Parse a change-request-shaped query into its number.
 *
 * Accepts `42`, `#42`, `!42`, `pr 42`, `pr42`, `PR #42`, `mr!42`, and so on.
 * Returns null for anything else, including text queries that merely contain
 * digits (`fix-42-retries`), so those fall through to normal text matching.
 */
function parseChangeRequestQuery(query: string): number | null {
  const match = CHANGE_REQUEST_QUERY.exec(query.trim());
  if (!match) return null;
  const number = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(number) ? number : null;
}

interface ScoredWorkspace {
  workspace: CommandCenterWorkspaceResult;
  score: CommandCenterScore | null;
  changeRequestHit: boolean;
}

function searchFields(workspace: CommandCenterWorkspaceResult) {
  return { visible: [workspace.title, workspace.subtitle], hidden: [] };
}

function compareScoredWorkspaces(
  left: ScoredWorkspace,
  right: ScoredWorkspace,
  tiebreak: (left: CommandCenterWorkspaceResult, right: CommandCenterWorkspaceResult) => number,
): number {
  if (left.changeRequestHit !== right.changeRequestHit) {
    return left.changeRequestHit ? -1 : 1;
  }
  if (left.score && right.score) {
    const scoreDelta = compareCommandCenterScores(left.score, right.score);
    if (scoreDelta !== 0) return scoreDelta;
  }
  return tiebreak(left.workspace, right.workspace);
}

export function filterAndRankWorkspaces(
  workspaces: readonly CommandCenterWorkspaceResult[],
  query: string,
  tiebreak: (left: CommandCenterWorkspaceResult, right: CommandCenterWorkspaceResult) => number,
): CommandCenterWorkspaceResult[] {
  if (!query.trim()) {
    return filterAndRankBuiltInResults(workspaces, query, searchFields, tiebreak);
  }

  const changeRequestNumber = parseChangeRequestQuery(query);
  const matches: ScoredWorkspace[] = [];
  for (const workspace of workspaces) {
    const score = scoreSearchFields(query, searchFields(workspace));
    const changeRequestHit =
      changeRequestNumber !== null && workspace.changeRequestNumber === changeRequestNumber;
    if (score || changeRequestHit) matches.push({ workspace, score, changeRequestHit });
  }
  matches.sort((left, right) => compareScoredWorkspaces(left, right, tiebreak));
  return matches.map((match) => match.workspace);
}
