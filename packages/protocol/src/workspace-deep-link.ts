export interface WorkspaceDeepLinkTarget {
  serverId: string;
  path: string;
}

const MAX_SERVER_ID_LENGTH = 256;
const MAX_WORKSPACE_PATH_LENGTH = 4_096;
const SERVER_ID_PATTERN = /^srv_[A-Za-z0-9_-]+$/;
const MAX_LINK_LENGTH = 50_000;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function normalizeWorkspaceDeepLinkTarget(
  target: WorkspaceDeepLinkTarget,
): WorkspaceDeepLinkTarget {
  const { serverId, path } = target;
  if (
    !SERVER_ID_PATTERN.test(serverId) ||
    serverId.length > MAX_SERVER_ID_LENGTH ||
    path.length > MAX_WORKSPACE_PATH_LENGTH ||
    path !== path.trim() ||
    hasControlCharacters(path) ||
    !path.startsWith("/") ||
    path.includes("\\") ||
    path
      .slice(1)
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Workspace deep links require a valid server ID and absolute path.");
  }
  return { serverId, path };
}

export function buildWorkspaceDeepLink(target: WorkspaceDeepLinkTarget): string {
  const normalized = normalizeWorkspaceDeepLinkTarget(target);
  const search = new URLSearchParams({ path: normalized.path });
  return `paseo://h/${encodeURIComponent(normalized.serverId)}/open-project?${search}`;
}

export function parseWorkspaceDeepLink(input: string): WorkspaceDeepLinkTarget | null {
  if (input.length > MAX_LINK_LENGTH || hasControlCharacters(input)) return null;
  const match = /^paseo:\/\/h\/(srv_[A-Za-z0-9_-]+)\/open-project\?path=([^&# ]+)$/.exec(input);
  if (!match) return null;

  try {
    return normalizeWorkspaceDeepLinkTarget({
      serverId: match[1] ?? "",
      path: decodeURIComponent((match[2] ?? "").replaceAll("+", " ")),
    });
  } catch {
    return null;
  }
}
