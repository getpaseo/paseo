import type { FetchAgentsEntry } from "@getpaseo/client/internal/daemon-client";
import type { AgentDirectoryDelta } from "./agent-directory-sync";
import { acceptAgentDirectoryUpdate } from "./agent-directory-update-policy";

export function reconcileAgentDirectory(input: {
  snapshot: FetchAgentsEntry[];
  deltas: readonly AgentDirectoryDelta[];
}): FetchAgentsEntry[] {
  const entries = new Map(input.snapshot.map((entry) => [entry.agent.id, entry]));

  for (const delta of input.deltas) {
    if (delta.kind === "remove") {
      entries.delete(delta.agentId);
      continue;
    }
    const previousEntry = entries.get(delta.agent.id);
    const acceptedAgent = acceptAgentDirectoryUpdate(previousEntry?.agent, delta.agent);
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

  return Array.from(entries.values());
}
