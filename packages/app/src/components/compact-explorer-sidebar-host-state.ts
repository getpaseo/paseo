import { buildWorkspaceTabPersistenceKey } from "@/stores/workspace-layout-store";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import type { WorkspaceDescriptor } from "@/stores/session-store";

export interface CompactExplorerSidebarHostModel {
  serverId: string;
  workspaceId: string;
  persistenceKey: string;
  workspaceRoot: string;
  isGit: boolean;
}

interface ResolveCompactExplorerSidebarHostModelInput {
  previous: CompactExplorerSidebarHostModel | null;
  selection: ActiveWorkspaceSelection | null;
  workspace: WorkspaceDescriptor | null;
  isGit: boolean;
}

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveCompactExplorerSidebarHostModel(
  input: ResolveCompactExplorerSidebarHostModelInput,
): CompactExplorerSidebarHostModel | null {
  const serverId = trimNonEmpty(input.selection?.serverId);
  const workspaceId = trimNonEmpty(input.selection?.workspaceId);
  if (!serverId || !workspaceId) {
    return null;
  }

  const persistenceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  if (!persistenceKey) {
    return null;
  }

  const previousForSelection =
    input.previous &&
    input.previous.serverId === serverId &&
    input.previous.workspaceId === workspaceId
      ? input.previous
      : null;

  return {
    serverId,
    workspaceId,
    persistenceKey,
    workspaceRoot:
      trimNonEmpty(input.workspace?.workspaceDirectory) ??
      previousForSelection?.workspaceRoot ??
      "",
    isGit: input.workspace ? input.isGit : (previousForSelection?.isGit ?? input.isGit),
  };
}
