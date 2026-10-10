export const CHATS_PROJECT_KEY = "__chats__" as const;

export interface ChatWorkspaceCandidate {
  workspaceKind?: string | null;
  projectViewKey?: string | null;
  projectKey?: string | null;
  projectName?: string | null;
  projectDisplayName?: string | null;
  workspaceDirectory?: string | null;
  cwd?: string | null;
}

export interface ChatsProjectCandidate {
  projectKey?: string | null;
  viewKey?: string | null;
  projectViewKey?: string | null;
  projectName?: string | null;
  projectDisplayName?: string | null;
  displayName?: string | null;
  name?: string | null;
  iconWorkingDir?: string | null;
  projectRootPath?: string | null;
  rootPath?: string | null;
}

export function isChatsProjectKey(key: string | null | undefined): boolean {
  return key === CHATS_PROJECT_KEY;
}

function isChatDirectoryPath(pathStr?: string | null): boolean {
  if (!pathStr) return false;
  const normalized = pathStr.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("paseo-chat-sessions") ||
    normalized.includes("/.paseo/chats") ||
    normalized.endsWith("/chats") ||
    normalized.endsWith("/chat")
  );
}

export function isChatsProject(project: ChatsProjectCandidate | null | undefined): boolean {
  if (!project) return false;
  if (
    project.projectKey === CHATS_PROJECT_KEY ||
    project.viewKey === CHATS_PROJECT_KEY ||
    project.projectViewKey === CHATS_PROJECT_KEY
  ) {
    return true;
  }
  const name =
    project.projectName ??
    project.projectDisplayName ??
    project.displayName ??
    project.name ??
    null;
  if (name && (name.toLowerCase() === "chats" || name.toLowerCase() === "chat")) {
    return true;
  }
  const root = project.iconWorkingDir ?? project.projectRootPath ?? project.rootPath ?? null;
  if (isChatDirectoryPath(root)) {
    return true;
  }
  return false;
}

export function isChatWorkspace(workspace: ChatWorkspaceCandidate | null | undefined): boolean {
  if (!workspace) return false;
  if (workspace.workspaceKind === "chat") {
    return true;
  }
  if (
    workspace.projectViewKey === CHATS_PROJECT_KEY ||
    workspace.projectKey === CHATS_PROJECT_KEY
  ) {
    return true;
  }
  const name = workspace.projectName ?? workspace.projectDisplayName ?? null;
  if (name && (name.toLowerCase() === "chats" || name.toLowerCase() === "chat")) {
    return true;
  }
  const dir = workspace.workspaceDirectory ?? workspace.cwd ?? null;
  if (isChatDirectoryPath(dir)) {
    return true;
  }
  return false;
}
