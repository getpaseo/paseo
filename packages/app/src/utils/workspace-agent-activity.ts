import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { deriveSidebarStateBucket } from "./sidebar-agent-state";

/**
 * One active root agent, as a sidebar row sees it.
 *
 * `enteredAt` is when the agent entered this status, not when it last changed. The reuse pass
 * below carries it forward for as long as `status` holds, so neither a running agent emitting a
 * frame every second nor a provider renaming the session restarts the clock.
 */
export interface WorkspaceAgentEntry {
  agentId: string;
  title: string | null;
  /** Immutable for the life of an agent, so the reuse pass below never has to compare it. */
  provider: AgentProvider;
  status: WorkspaceDescriptor["status"];
  enteredAt: Date;
}

/**
 * Every active root agent in a workspace, most recently active first, plus the winner's fields
 * inlined so the workspace row can read them without indexing.
 *
 * The inlined fields are `agents[0]`, not a separate derivation: a row showing a different status
 * from the agent at the top of its own list is the bug this shape exists to make impossible.
 */
export interface WorkspaceAgentActivity {
  agentId: string;
  status: WorkspaceDescriptor["status"];
  enteredAt: Date | null;
  agents: readonly WorkspaceAgentEntry[];
}

interface Candidate {
  entry: WorkspaceAgentEntry;
  /**
   * The agent's real timestamp, used only for ordering. Deliberately not `entry.enteredAt`: the
   * winner is whoever moved most recently, while the exposed `enteredAt` is the preserved
   * status-entry time. Sorting on the preserved value would let a long-running agent outrank one
   * that just finished.
   */
  sortAt: number;
}

export function buildWorkspaceAgentActivityIndex(
  agents: ReadonlyMap<string, Agent>,
  previous?: ReadonlyMap<string, WorkspaceAgentActivity>,
): Map<string, WorkspaceAgentActivity> {
  const candidatesByWorkspaceId = new Map<string, Candidate[]>();

  for (const agent of agents.values()) {
    const parentAgent = agent.parentAgentId ? agents.get(agent.parentAgentId) : undefined;
    if (agent.archivedAt || !agent.workspaceId || !isWorkspaceRootAgent(agent, parentAgent)) {
      continue;
    }

    const enteredAt = agent.attentionTimestamp ?? agent.updatedAt;
    const candidate: Candidate = {
      entry: {
        agentId: agent.id,
        title: agent.title,
        provider: agent.provider,
        status: deriveSidebarStateBucket({
          status: agent.status,
          pendingPermissionCount: agent.pendingPermissions.length,
          requiresAttention: agent.requiresAttention,
          attentionReason: agent.attentionReason,
        }),
        enteredAt,
      },
      sortAt: enteredAt.getTime(),
    };
    const existing = candidatesByWorkspaceId.get(agent.workspaceId);
    if (existing) {
      existing.push(candidate);
    } else {
      candidatesByWorkspaceId.set(agent.workspaceId, [candidate]);
    }
  }

  const activityByWorkspaceId = new Map<string, WorkspaceAgentActivity>();
  for (const [workspaceId, candidates] of candidatesByWorkspaceId) {
    // Ties break on id so two agents stamped in the same millisecond do not swap places between
    // renders, which would swap the workspace row's dot for no reason a user could see.
    candidates.sort((left, right) =>
      left.sortAt === right.sortAt
        ? left.entry.agentId.localeCompare(right.entry.agentId)
        : right.sortAt - left.sortAt,
    );

    const previousActivity = previous?.get(workspaceId);
    const nextAgents = reuseAgentEntries(
      candidates.map((candidate) => candidate.entry),
      previousActivity?.agents,
    );
    const winner = nextAgents[0];
    if (!winner) continue;

    const nextActivity: WorkspaceAgentActivity = {
      agentId: winner.agentId,
      status: winner.status,
      enteredAt: winner.enteredAt,
      agents: nextAgents,
    };
    activityByWorkspaceId.set(
      workspaceId,
      previousActivity && areActivitiesIdentical(previousActivity, nextActivity)
        ? previousActivity
        : nextActivity,
    );
  }

  if (previous && areWorkspaceAgentActivityIndexesIdentical(previous, activityByWorkspaceId)) {
    return previous instanceof Map ? previous : new Map(previous);
  }
  return activityByWorkspaceId;
}

/**
 * Swap every unchanged entry back to the object the last build produced, and return the previous
 * array itself when nothing moved. Callers compare `agents` with `Object.is`
 * (`areSidebarWorkspaceEntriesEqual`), so the array reference is what decides whether a workspace
 * row re-renders.
 *
 * The memory is one rebuild deep, on purpose. An agent missing from `previous` is stamped fresh,
 * so archiving an agent and restoring it restarts its clock — it left the sidebar and came back,
 * and preserving the old time would need history this index deliberately does not keep. The test
 * named for unarchiving pins that, so it reads as a decision rather than an oversight.
 *
 * The only other caller builds without a `previous` at all (`session-store.ts:808`), and that one
 * is a cold restore guarded on there being no session yet — there are no clocks to carry.
 */
function reuseAgentEntries(
  next: WorkspaceAgentEntry[],
  previous: readonly WorkspaceAgentEntry[] | undefined,
): readonly WorkspaceAgentEntry[] {
  if (!previous || previous.length === 0) {
    return next;
  }

  const previousById = new Map(previous.map((entry) => [entry.agentId, entry]));
  let identical = next.length === previous.length;
  for (let index = 0; index < next.length; index += 1) {
    const entry = next[index];
    if (!entry) continue;
    const previousEntry = previousById.get(entry.agentId);
    if (previousEntry && previousEntry.status === entry.status) {
      // The status is what `enteredAt` is timing, so it alone decides whether the clock keeps
      // running. A title changes while an agent works — providers name a session from its first
      // turn — and letting that restart the clock would push the winner's `statusEnteredAt`, and
      // with it the row's "Last activity" stamp, forward on a rename.
      next[index] =
        previousEntry.title === entry.title
          ? previousEntry
          : { ...entry, enteredAt: previousEntry.enteredAt };
    }
    if (next[index] !== previous[index]) {
      identical = false;
    }
  }

  return identical ? previous : next;
}

function areActivitiesIdentical(
  previous: WorkspaceAgentActivity,
  next: WorkspaceAgentActivity,
): boolean {
  return (
    previous.agents === next.agents &&
    previous.agentId === next.agentId &&
    previous.status === next.status
  );
}

function areWorkspaceAgentActivityIndexesIdentical(
  previous: ReadonlyMap<string, WorkspaceAgentActivity>,
  next: ReadonlyMap<string, WorkspaceAgentActivity>,
): boolean {
  if (previous.size !== next.size) {
    return false;
  }
  for (const [workspaceId, activity] of next) {
    if (previous.get(workspaceId) !== activity) {
      return false;
    }
  }
  return true;
}
