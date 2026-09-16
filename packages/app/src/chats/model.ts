export const CHATS_PROJECT_KEY = "__chats__" as const;

export interface ChatWorkspaceCandidate {
  workspaceKind?: string | null;
  projectViewKey?: string | null;
  projectKey?: string | null;
}

export interface ChatsProjectCandidate {
  projectKey?: string | null;
  viewKey?: string | null;
  projectViewKey?: string | null;
}

export function isChatsProjectKey(key: string | null | undefined): boolean {
  return key === CHATS_PROJECT_KEY;
}

export function isChatsProject(project: ChatsProjectCandidate | null | undefined): boolean {
  if (!project) return false;
  return (
    project.projectKey === CHATS_PROJECT_KEY ||
    project.viewKey === CHATS_PROJECT_KEY ||
    project.projectViewKey === CHATS_PROJECT_KEY
  );
}

export function isChatWorkspace(workspace: ChatWorkspaceCandidate | null | undefined): boolean {
  if (!workspace) return false;
  return (
    workspace.workspaceKind === "chat" ||
    workspace.projectViewKey === CHATS_PROJECT_KEY ||
    workspace.projectKey === CHATS_PROJECT_KEY
  );
}
