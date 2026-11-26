import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";

/**
 * The workspace a checkout's git action comes from, for the helpers that write its text: the
 * active workspace when it is on this checkout, else the only workspace there. Several workspaces
 * can share a checkout, and then none is guessed.
 */
export function resolveCheckoutWorkspaceId(input: {
  workspaces: Map<string, WorkspaceDescriptor> | undefined;
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
  cwd: string;
}): string | undefined {
  const activeKey = input.activeWorkspaceSelection
    ? resolveWorkspaceMapKeyByIdentity({
        workspaces: input.workspaces,
        workspaceId: input.activeWorkspaceSelection.workspaceId,
      })
    : null;
  const active = activeKey ? input.workspaces?.get(activeKey) : undefined;
  if (active?.workspaceDirectory === input.cwd) return active.id;
  const onCheckout = [...(input.workspaces?.values() ?? [])].filter(
    (workspace) => workspace.workspaceDirectory === input.cwd,
  );
  return onCheckout.length === 1 ? onCheckout[0]?.id : undefined;
}
