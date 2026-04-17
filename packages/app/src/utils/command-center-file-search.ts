import {
  parseHostAgentRouteFromPathname,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";

export interface CommandCenterWorkspaceAgent {
  id: string;
  cwd: string;
  serverId: string;
}

export interface CommandCenterFileMatch {
  path: string;
  name: string;
  directory: string;
}

export interface CommandCenterWorkspaceScope {
  serverId: string;
  workspaceId: string;
}

interface DirectorySuggestionPayload {
  entries?: Array<{ path: string; kind: string }>;
}

export function resolveCommandCenterWorkspaceScope(input: {
  pathname: string;
  agents: CommandCenterWorkspaceAgent[];
}): CommandCenterWorkspaceScope | null {
  const workspaceRoute = parseHostWorkspaceRouteFromPathname(input.pathname);
  if (workspaceRoute) {
    return workspaceRoute;
  }

  const agentRoute = parseHostAgentRouteFromPathname(input.pathname);
  if (!agentRoute) {
    return null;
  }

  const agent = input.agents.find(
    (entry) => entry.serverId === agentRoute.serverId && entry.id === agentRoute.agentId,
  );
  const workspaceId = normalizeSuggestionPath(agent?.cwd);
  if (!workspaceId) {
    return null;
  }

  return {
    serverId: agentRoute.serverId,
    workspaceId,
  };
}

export function mapDirectorySuggestionsToCommandCenterFiles(
  payload: DirectorySuggestionPayload,
): CommandCenterFileMatch[] {
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  return entries.flatMap((entry) => {
    if (!entry || entry.kind !== "file") {
      return [];
    }

    const normalizedPath = normalizeSuggestionPath(entry.path);
    if (!normalizedPath) {
      return [];
    }

    return [buildCommandCenterFileMatch(normalizedPath)];
  });
}

function buildCommandCenterFileMatch(path: string): CommandCenterFileMatch {
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? path;
  const directory = segments.length > 1 ? segments.slice(0, -1).join("/") : ".";

  return {
    path,
    name,
    directory,
  };
}

function normalizeSuggestionPath(path: string | null | undefined): string | null {
  if (typeof path !== "string") {
    return null;
  }
  const trimmed = path.trim().replace(/\\/g, "/");
  return trimmed.length > 0 ? trimmed : null;
}
