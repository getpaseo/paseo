import type { FetchAgentsEntry } from "@getpaseo/client/internal/daemon-client";
import type { Agent } from "@/stores/session-store";
import type { AgentDirectoryDelta } from "./agent-directory-sync";
import { acceptAgentDirectoryUpdate } from "./agent-directory-update-policy";

export function reconcileAgentDirectory(input: {
  previous: ReadonlyMap<string, Agent>;
  snapshot: FetchAgentsEntry[];
  deltas: readonly AgentDirectoryDelta[];
}): { entries: FetchAgentsEntry[]; stoppedRunningAgentIds: string[] } {
  const entries = new Map(input.snapshot.map((entry) => [entry.agent.id, entry]));
  const statuses = new Map(Array.from(input.previous, ([id, agent]) => [id, agent.status]));
  const stoppedRunningAgentIds = new Set<string>();

  for (const entry of input.snapshot) {
    if (statuses.get(entry.agent.id) === "running" && entry.agent.status !== "running") {
      stoppedRunningAgentIds.add(entry.agent.id);
    }
    statuses.set(entry.agent.id, entry.agent.status);
  }

  for (const delta of input.deltas) {
    if (delta.kind === "remove") {
      entries.delete(delta.agentId);
      statuses.delete(delta.agentId);
      stoppedRunningAgentIds.delete(delta.agentId);
      continue;
    }
    const previousEntry = entries.get(delta.agent.id);
    const acceptedAgent = acceptAgentDirectoryUpdate(previousEntry?.agent, delta.agent);
    if (acceptedAgent.status === "running") {
      stoppedRunningAgentIds.delete(delta.agent.id);
    } else if (statuses.get(delta.agent.id) === "running") {
      stoppedRunningAgentIds.add(delta.agent.id);
    }
    statuses.set(delta.agent.id, acceptedAgent.status);
    const previousProject = previousEntry?.project;
    const acceptedProject =
      acceptedAgent === delta.agent ? (delta.project ?? previousProject) : previousProject;
    entries.set(delta.agent.id, {
      agent: acceptedAgent,
      project: acceptedProject ?? {
        projectKey: delta.agent.cwd,
        projectName: /[^/]+$/.exec(delta.agent.cwd)?.[0] ?? delta.agent.cwd,
        checkout: {
          cwd: delta.agent.cwd,
          isGit: false,
          currentBranch: null,
          remoteUrl: null,
          worktreeRoot: null,
          isPaseoOwnedWorktree: false,
          mainRepoRoot: null,
        },
      },
    });
  }

  return {
    entries: Array.from(entries.values()),
    stoppedRunningAgentIds: Array.from(stoppedRunningAgentIds),
  };
}
