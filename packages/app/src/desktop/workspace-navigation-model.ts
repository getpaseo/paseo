import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceDeepLinkTarget } from "@getpaseo/protocol/workspace-deep-link";

export type WorkspaceDeepLinkAction =
  | { kind: "connect-host" }
  | { kind: "wait-for-directory" }
  | { kind: "open-workspace"; workspaceId: string }
  | { kind: "register-project" };

export async function registerLinkedProject<T>(input: {
  confirm: () => Promise<boolean>;
  isCurrent: () => boolean;
  register: () => Promise<T>;
}): Promise<T | null> {
  if (!(await input.confirm()) || !input.isCurrent()) return null;
  return input.register();
}

export function resolveWorkspaceDeepLinkAction(input: {
  target: WorkspaceDeepLinkTarget;
  hostExists: boolean;
  directoryReady: boolean;
  workspaces: Iterable<WorkspaceDescriptor>;
}): WorkspaceDeepLinkAction {
  if (!input.hostExists) return { kind: "connect-host" };
  if (!input.directoryReady) return { kind: "wait-for-directory" };

  for (const workspace of input.workspaces) {
    if (workspace.workspaceDirectory === input.target.path) {
      return { kind: "open-workspace", workspaceId: workspace.id };
    }
  }

  return { kind: "register-project" };
}
