import {
  compareBuiltInScores,
  compareByRecency,
  matchesSearchFieldsContiguously,
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

interface AgentMatch {
  agent: CommandCenterWorkspaceAgent;
  score: CommandCenterScore;
}

/**
 * The workspace's best-matching agent. Each agent is scored together with the workspace's
 * text, so a query split across the two finds it. With `contiguousOnly`, only an agent that
 * matches contiguously counts. Agents arrive most recent first, so a tie keeps the newer one.
 */
function agentMatch(
  workspace: CommandCenterWorkspaceResult,
  query: string,
  contiguousOnly: boolean,
): AgentMatch | null {
  let best: AgentMatch | null = null;
  for (const agent of workspace.agents) {
    const fields = agentSearchFields(workspace, agent);
    const score = scoreSearchFields(query, fields);
    if (!score) continue;
    if (contiguousOnly && !matchesSearchFieldsContiguously(query, fields)) continue;
    if (!best || compareBuiltInScores(score, best.score) < 0) best = { agent, score };
  }
  return best;
}

export type WorkspaceRanker = (
  workspaces: readonly CommandCenterWorkspaceResult[],
  query: string,
  options?: { keepUnmatched?: boolean },
) => CommandCenterWorkspaceResult[];

/**
 * Rank workspaces for a query, best match first. A workspace matches on its own title, project,
 * branch and change request, or on those together with the title of one of its agents. It is
 * matched through an agent only when its own text does not match or matches only loosely; such
 * a match comes back naming that agent, and opens it.
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
      const ownFields = ownSearchFields(workspace);
      const own = scoreSearchFields(query, ownFields);
      // The workspace answers the query itself: no agent line, and Enter opens the workspace.
      const ownMatch =
        changeRequestHit || (own !== null && matchesSearchFieldsContiguously(query, ownFields));
      // Over a loose own match, only an agent that matches contiguously is named.
      const throughAgent = agentMatch(workspace, query, own !== null && !ownMatch);
      if (ownMatch) {
        // Ranked by the better of its own match and its agents', so typing further into an
        // agent's title does not drop it below workspaces that match only through that title.
        const score =
          own && throughAgent && compareBuiltInScores(throughAgent.score, own) < 0
            ? throughAgent.score
            : (own ?? throughAgent?.score ?? null);
        matches.push({ workspace, via: OWN_MATCH, score, agent: null, changeRequestHit });
        continue;
      }
      if (throughAgent) {
        matches.push({
          workspace,
          via: AGENT_MATCH,
          score: throughAgent.score,
          agent: throughAgent.agent,
          changeRequestHit,
        });
        continue;
      }
      if (own) {
        matches.push({ workspace, via: OWN_MATCH, score: own, agent: null, changeRequestHit });
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
