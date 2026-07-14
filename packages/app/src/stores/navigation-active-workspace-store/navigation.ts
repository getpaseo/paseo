import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { pickAttentionAgent } from "@/utils/agent-attention";
import {
  buildHostWorkspaceRoute,
  decodeWorkspaceIdFromPathSegment,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";
import {
  normalizeWorkspaceOpaqueId,
  resolveWorkspaceMapKeyByIdentity,
} from "@/utils/workspace-identity";
import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import { prepareWorkspaceTab, type PrepareWorkspaceTabDeps } from "@/utils/prepare-workspace-tab";

export interface RouteSelectionInput {
  pathname: string;
  params: {
    serverId?: string | string[];
    workspaceId?: string | string[];
  };
}

export interface NavigateToWorkspaceInput {
  serverId: string;
  workspaceId: string;
  target?: WorkspaceTabTarget;
  pin?: boolean;
}

export interface NavigateToWorkspaceDeps extends PrepareWorkspaceTabDeps {
  getSessionWorkspaces: (serverId: string) => Map<string, WorkspaceDescriptor> | null | undefined;
  getSessionAgents: (serverId: string) => Iterable<Agent>;
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
  const routeSelection = parseHostWorkspaceRouteFromPathname(input.pathname);
  if (routeSelection) {
    return routeSelection;
  }

  if (input.pathname !== "/" && input.pathname !== "") {
    return null;
  }

  return parseWorkspaceSelectionFromRouteParams(input.params);
}

export function navigateToWorkspace(
  input: NavigateToWorkspaceInput,
  deps: NavigateToWorkspaceDeps,
): string {
  if (input.target) {
    prepareWorkspaceTab({ ...input, target: input.target }, deps);
  } else {
    const workspaces = deps.getSessionWorkspaces(input.serverId);
    const resolvedWorkspaceId = resolveWorkspaceMapKeyByIdentity({
      workspaces,
      workspaceId: input.workspaceId,
    });
    const workspaceAgents = resolvedWorkspaceId
      ? Array.from(deps.getSessionAgents(input.serverId)).filter(
          (agent) => normalizeWorkspaceOpaqueId(agent.workspaceId) === resolvedWorkspaceId,
        )
      : [];
    const attentionAgentId = pickAttentionAgent(workspaceAgents);
    if (attentionAgentId && resolvedWorkspaceId) {
      deps.openTabFocused(`${input.serverId}:${resolvedWorkspaceId}`, {
        kind: "agent",
        agentId: attentionAgentId,
      });
    }
  }

  const route = buildHostWorkspaceRoute(input.serverId, input.workspaceId);
  deps.rememberLastWorkspace({ serverId: input.serverId, workspaceId: input.workspaceId });
  deps.navigateToRoute(route);
  return route;
}

export function navigateToLastWorkspace(deps: NavigateToLastWorkspaceDeps): boolean {
  const selection = deps.getLastWorkspaceSelection();
  if (!selection) {
    return false;
  }
  navigateToWorkspace(selection, deps);
  return true;
}
