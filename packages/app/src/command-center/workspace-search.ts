import {
  compareBuiltInScores,
  compareByRecency,
  scoreSearchFields,
  type CommandCenterScore,
  type CommandCenterWorkspaceAgent,
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

/** A match on the workspace's own text, ahead of an equally good match through one of its agents. */
const OWN_MATCH = 0;
const AGENT_MATCH = 1;
/** The host matched it (typo-tolerant, server-side) but nothing here does. Archived rows only. */
const HOST_MATCH = 2;

interface ScoredWorkspace {
  workspace: CommandCenterWorkspaceResult;
  via: typeof OWN_MATCH | typeof AGENT_MATCH | typeof HOST_MATCH;
  score: CommandCenterScore | null;
  agent: CommandCenterWorkspaceAgent | null;
  changeRequestHit: boolean;
}

function ownSearchFields(workspace: CommandCenterWorkspaceResult) {
  return { visible: [workspace.title, workspace.subtitle], hidden: [] };
}

/** An agent is found through its own title and its workspace's text together. */
function agentSearchFields(
  workspace: CommandCenterWorkspaceResult,
  agent: CommandCenterWorkspaceAgent,
) {
  return { visible: [workspace.title, workspace.subtitle, agent.title], hidden: [] };
}

/** Change-request hits first, host-only matches last, then match quality, own text, recency. */
function compareScoredWorkspaces(left: ScoredWorkspace, right: ScoredWorkspace): number {
  if (left.changeRequestHit !== right.changeRequestHit) {
    return left.changeRequestHit ? -1 : 1;
  }
  if ((left.via === HOST_MATCH) !== (right.via === HOST_MATCH)) {
    return left.via === HOST_MATCH ? 1 : -1;
  }
  if (left.score && right.score) {
    const scoreDelta = compareBuiltInScores(left.score, right.score);
    if (scoreDelta !== 0) return scoreDelta;
  }
  if (left.via !== right.via) return left.via - right.via;
  return compareByRecency(left.workspace, right.workspace);
}

interface WorkspaceMatch {
  score: CommandCenterScore;
  /** The agent the match went through, or null for the workspace's own text. */
  agent: CommandCenterWorkspaceAgent | null;
}

/**
 * The workspace's best match: its own text, or one of its agents scored together with that
 * text. An agent wins only by matching better, so a query the workspace answers on its own
 * names no agent. Agents arrive most recent first, so a tie between agents keeps the newer one.
 */
function bestMatch(workspace: CommandCenterWorkspaceResult, query: string): WorkspaceMatch | null {
  const own = scoreSearchFields(query, ownSearchFields(workspace));
  let best: WorkspaceMatch | null = own ? { score: own, agent: null } : null;
  for (const agent of workspace.agents) {
    const score = scoreSearchFields(query, agentSearchFields(workspace, agent));
    if (score && (!best || compareBuiltInScores(score, best.score) < 0)) {
      best = { score, agent };
    }
  }
  return best;
}

export type WorkspaceRanker = (
  workspaces: readonly CommandCenterWorkspaceResult[],
  query: string,
  options?: { keepUnmatched?: boolean },
) => CommandCenterWorkspaceResult[];

/**
 * Rank workspaces for a query, best match first. A workspace matches on its own title, project
 * and branch, or on those together with the title of one of its agents; a match through an
 * agent comes back naming that agent, and opens it.
 *
 * An empty query lists every workspace, most recent first. `keepUnmatched` keeps rows nothing
 * here matches, ranked last: archived rows come from the host's own search, which is
 * typo-tolerant, so the host is the authority on whether they match.
 *
 * The ranker remembers the row it made for each workspace and agent, so a row matched through
 * the same agent is the same object on every keystroke and its list row does not re-render.
 */
export function createWorkspaceRanker(): WorkspaceRanker {
  const viaAgent = new WeakMap<
    CommandCenterWorkspaceResult,
    Map<string, CommandCenterWorkspaceResult>
  >();

  function matchedThrough(
    workspace: CommandCenterWorkspaceResult,
    agent: CommandCenterWorkspaceAgent,
  ): CommandCenterWorkspaceResult {
    let rows = viaAgent.get(workspace);
    if (!rows) {
      rows = new Map();
      viaAgent.set(workspace, rows);
    }
    let row = rows.get(agent.id);
    if (!row) {
      row = { ...workspace, matchedAgent: agent, run: () => workspace.openAgent(agent.id) };
      rows.set(agent.id, row);
    }
    return row;
  }

  return (workspaces, query, options = {}) => {
    if (!query.trim()) return [...workspaces].sort(compareByRecency);

    const changeRequestNumber = parseChangeRequestQuery(query);
    const matches: ScoredWorkspace[] = [];
    for (const workspace of workspaces) {
      const changeRequestHit =
        changeRequestNumber !== null && workspace.changeRequestNumber === changeRequestNumber;
      const match = bestMatch(workspace, query);
      if (match || changeRequestHit) {
        matches.push({
          workspace,
          via: match?.agent ? AGENT_MATCH : OWN_MATCH,
          score: match?.score ?? null,
          agent: match?.agent ?? null,
          changeRequestHit,
        });
        continue;
      }
      if (options.keepUnmatched) {
        matches.push({ workspace, via: HOST_MATCH, score: null, agent: null, changeRequestHit });
      }
    }
    matches.sort(compareScoredWorkspaces);
    return matches.map((match) =>
      match.agent ? matchedThrough(match.workspace, match.agent) : match.workspace,
    );
  };
}
