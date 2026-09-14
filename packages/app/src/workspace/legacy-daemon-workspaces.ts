import {
  useSessionStore,
  type Agent,
  type DaemonServerInfo,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import { normalizeWorkspacePath } from "@/utils/workspace-identity";

// COMPAT(legacyWorkspaceDaemon): added in v0.1.97, remove after 2027-03-09.
// Cached or partial agent records can predate workspace IDs; preserve their placement.
function shouldBackfillLegacyDaemonWorkspaceDirectory(
  serverInfo: DaemonServerInfo | null | undefined,
): boolean {
  return serverInfo?.features?.workspaceMultiplicity !== true;
}

export function applyLegacyDaemonWorkspaceOwnership(input: {
  serverId: string;
  agent: Agent;
}): Agent {
  if (input.agent.workspaceId) {
    return input.agent;
  }

  const session = useSessionStore.getState().sessions[input.serverId];
  if (!shouldBackfillLegacyDaemonWorkspaceDirectory(session?.serverInfo)) {
    return input.agent;
  }

  const existingAgent =
    session?.agents.get(input.agent.id) ?? session?.agentDetails.get(input.agent.id);
  const workspaces = session?.workspaces;
  const workspaceId =
    existingAgent?.workspaceId ??
    resolveLegacyWorkspaceIdFromAgent(input.agent, workspaces) ??
    null;
  if (!workspaceId) {
    return input.agent;
  }

  return {
    ...input.agent,
    workspaceId,
    projectPlacement: input.agent.projectPlacement ?? existingAgent?.projectPlacement,
  };
}

function resolveLegacyWorkspaceIdFromAgent(
  agent: Agent,
  workspaces: ReadonlyMap<string, WorkspaceDescriptor> | undefined,
): string | null {
  const cwd = normalizeWorkspacePath(agent.cwd);
  if (!cwd) {
    return null;
  }

  for (const workspace of workspaces?.values() ?? []) {
    if (normalizeWorkspacePath(workspace.workspaceDirectory) === cwd) {
      return workspace.id;
    }
  }

  return cwd;
}
