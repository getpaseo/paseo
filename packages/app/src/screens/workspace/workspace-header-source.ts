import type { WorkspaceDescriptor } from "@/stores/session-store";
import { projectDisplayNameFromProjectId } from "@/utils/project-display-name";

export function resolveWorkspaceHeader(input: { workspace: WorkspaceDescriptor }): {
  title: string;
  subtitle: string;
} {
  return {
    title: input.workspace.name,
    subtitle: projectDisplayNameFromProjectId(input.workspace.projectId),
  };
}

export function shouldRenderMissingWorkspaceDescriptor(input: {
  workspace: WorkspaceDescriptor | null;
  hasHydratedWorkspaces: boolean;
}): boolean {
  return !input.workspace && input.hasHydratedWorkspaces;
}
