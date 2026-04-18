import type { ScriptStatusUpdateMessage } from "@server/shared/messages";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-execution";

export function patchWorkspaceScripts(
  workspaces: Map<string, WorkspaceDescriptor>,
  update: ScriptStatusUpdateMessage["payload"],
): Map<string, WorkspaceDescriptor> {
  const workspaceKey = resolveWorkspaceMapKeyByIdentity({
    workspaces,
    workspaceId: update.workspaceId,
  });
  if (!workspaceKey) {
    return workspaces;
  }

  const existing = workspaces.get(workspaceKey);
  if (!existing) {
    return workspaces;
  }

  const next = new Map(workspaces);
  next.set(workspaceKey, {
    ...existing,
    scripts: update.scripts.map((s) => ({ ...s })),
  });
  return next;
}
