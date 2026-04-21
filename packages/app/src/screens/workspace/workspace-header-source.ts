import type { WorkspaceDescriptor } from "@/stores/session-store";

export function resolveWorkspaceHeader(input: { workspace: WorkspaceDescriptor }): {
  title: string;
  subtitle: string;
} {
  return {
    title: input.workspace.name,
    subtitle: input.workspace.projectDisplayName,
  };
}

export function shouldRenderMissingWorkspaceDescriptor(input: {
  workspace: WorkspaceDescriptor | null;
  hasHydratedWorkspaces: boolean;
}): boolean {
  return !input.workspace && input.hasHydratedWorkspaces;
}
