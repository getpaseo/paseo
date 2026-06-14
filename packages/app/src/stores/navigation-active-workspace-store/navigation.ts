import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { pickAttentionAgent } from "@/utils/agent-attention";
import {
  buildHostWorkspaceRoute,
  decodeWorkspaceIdFromPathSegment,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";
import {
  resolveWorkspaceIdByDirectory,
  resolveWorkspaceMapKeyByIdentity,
} from "@/utils/workspace-identity";
import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";

export interface RouteSelectionInput {
  pathname: string;
  params: {
    serverId?: string | string[];
    workspaceId?: string | string[];
  };
}

export interface NavigateToWorkspaceDeps {
  getSessionWorkspaces: (serverId: string) => Map<string, WorkspaceDescriptor> | null | undefined;
  getSessionAgents: (serverId: string) => Iterable<Agent>;
  openWorkspaceAgentTab: (workspaceKey: string, agentId: string) => void;
  rememberLastWorkspace: (selection: ActiveWorkspaceSelection) => void;
  navigateToRoute: (route: string) => void;
}

export interface NavigateToLastWorkspaceDeps extends NavigateToWorkspaceDeps {
  getLastWorkspaceSelection: () => ActiveWorkspaceSelection | null;
}

function getParamValue(value: string | string[] | undefined): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const firstValue = value[0];
    return typeof firstValue === "string" ? firstValue.trim() : "";
  }
  return "";
}

function parseWorkspaceSelectionFromRouteParams(params: {
  serverId?: string | string[];
  workspaceId?: string | string[];
}): ActiveWorkspaceSelection | null {
  const serverId = getParamValue(params.serverId);
  const workspaceValue = getParamValue(params.workspaceId);
  const workspaceId = workspaceValue ? decodeWorkspaceIdFromPathSegment(workspaceValue) : null;
  if (!serverId || !workspaceId) {
    return null;
  }
  return { serverId, workspaceId };
}

export function parseActiveWorkspaceSelection(
  input: RouteSelectionInput,
): ActiveWorkspaceSelection | null {
  return (
    parseHostWorkspaceRouteFromPathname(input.pathname) ??
    parseWorkspaceSelectionFromRouteParams(input.params)
  );
}

export function navigateToWorkspace(
  serverId: string,
  workspaceId: string,
  deps: NavigateToWorkspaceDeps,
): void {
  const workspaces = deps.getSessionWorkspaces(serverId);
  const resolvedWorkspaceId = resolveWorkspaceMapKeyByIdentity({
    workspaces,
    workspaceId,
  });
  const workspaceAgents = resolvedWorkspaceId
    ? Array.from(deps.getSessionAgents(serverId)).filter(
        (agent) =>
          resolveWorkspaceIdByDirectory({
            workspaces: workspaces?.values(),
            workspaceDirectory: agent.cwd,
          }) === resolvedWorkspaceId,
      )
    : [];
  const attentionAgentId = pickAttentionAgent(workspaceAgents);
  if (attentionAgentId && resolvedWorkspaceId) {
    deps.openWorkspaceAgentTab(`${serverId}:${resolvedWorkspaceId}`, attentionAgentId);
  }

  deps.rememberLastWorkspace({ serverId, workspaceId });
  deps.navigateToRoute(buildHostWorkspaceRoute(serverId, workspaceId));
}

export function navigateToLastWorkspace(deps: NavigateToLastWorkspaceDeps): boolean {
  const selection = deps.getLastWorkspaceSelection();
  if (!selection) {
    return false;
  }
  navigateToWorkspace(selection.serverId, selection.workspaceId, deps);
  return true;
}
