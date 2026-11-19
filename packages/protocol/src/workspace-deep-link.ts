export interface WorkspaceDeepLinkTarget {
  serverId: string;
  path: string;
}

const MAX_SERVER_ID_LENGTH = 256;
const MAX_WORKSPACE_PATH_LENGTH = 4_096;
const SERVER_ID_PATTERN = /^srv_[A-Za-z0-9_-]+$/;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\)/;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isAbsoluteWorkspacePath(value: string): boolean {
  return value.startsWith("/") || WINDOWS_ABSOLUTE_PATH_PATTERN.test(value);
}

function normalizeWorkspaceDeepLinkTarget(
  target: WorkspaceDeepLinkTarget,
): WorkspaceDeepLinkTarget {
  const serverId = target.serverId.trim();
  const path = target.path.trim();
  if (
    !SERVER_ID_PATTERN.test(serverId) ||
    serverId.length > MAX_SERVER_ID_LENGTH ||
    !path ||
    path.length > MAX_WORKSPACE_PATH_LENGTH ||
    hasControlCharacters(path) ||
    !isAbsoluteWorkspacePath(path)
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
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (
    url.protocol !== "paseo:" ||
    url.hostname !== "h" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const searchEntries = [...url.searchParams.entries()];
  if (
    segments.length !== 2 ||
    segments[1] !== "open-project" ||
    searchEntries.length !== 1 ||
    searchEntries[0]?.[0] !== "path"
  ) {
    return null;
  }

  try {
    return normalizeWorkspaceDeepLinkTarget({
      serverId: decodeURIComponent(segments[0] ?? ""),
      path: searchEntries[0]?.[1] ?? "",
    });
  } catch {
    return null;
  }
}
