import { useShallow } from "zustand/shallow";
import { useCreateFlowStore, type PendingCreateAttempt } from "@/stores/create-flow-store";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceAgentActivity } from "@/utils/workspace-agent-activity";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";

interface EffectiveWorkspaceStatus {
  status: WorkspaceDescriptor["status"];
  enteredAt: Date | null;
}

export function deriveEffectiveWorkspaceStatus(input: {
  serverId: string;
  workspace: WorkspaceDescriptor;
  pendingCreateAttempts?: Record<string, PendingCreateAttempt>;
  workspaceAgentActivity?: ReadonlyMap<string, WorkspaceAgentActivity>;
}): EffectiveWorkspaceStatus {
  if (input.workspace.status !== "done") {
    return { status: input.workspace.status, enteredAt: input.workspace.statusEnteredAt };
  }

  const pendingStartedAt = getPendingInitialAgentCreateStartedAt({
    serverId: input.serverId,
    workspaceId: input.workspace.id,
    pendingCreateAttempts: input.pendingCreateAttempts,
  });
  if (pendingStartedAt) {
    return { status: "running", enteredAt: pendingStartedAt };
  }

  const rootAgentActivity = input.workspaceAgentActivity?.get(input.workspace.id);
  if (rootAgentActivity && rootAgentActivity.status !== "done") {
    return rootAgentActivity;
  }

  return { status: input.workspace.status, enteredAt: input.workspace.statusEnteredAt };
}

function getPendingInitialAgentCreateStartedAt(input: {
  serverId: string;
  workspaceId: string;
  pendingCreateAttempts: Record<string, PendingCreateAttempt> | undefined;
}): Date | null {
  let latestStartedAt: Date | null = null;
  for (const pending of Object.values(input.pendingCreateAttempts ?? {})) {
    if (pending.serverId !== input.serverId) continue;
    if (pending.workspaceId !== input.workspaceId) continue;
    if (pending.lifecycle === "abandoned") continue;
    const startedAt = new Date(pending.timestamp);
    if (!latestStartedAt || startedAt > latestStartedAt) {
      latestStartedAt = startedAt;
    }
  }
  return latestStartedAt;
}

export function useWorkspaceStatus(serverId: string, workspaceId: string) {
  const pendingCreateAttempts = useCreateFlowStore((state) => state.pendingByDraftId);
  return useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      if (!session) return null;
      const key = resolveWorkspaceMapKeyByIdentity({ workspaces: session.workspaces, workspaceId });
      const workspace = key ? session.workspaces.get(key) : null;
      if (!workspace) return null;
      return deriveEffectiveWorkspaceStatus({
        serverId,
        workspace,
        pendingCreateAttempts,
        workspaceAgentActivity: session.workspaceAgentActivity,
      }).status;
    }),
  );
}
