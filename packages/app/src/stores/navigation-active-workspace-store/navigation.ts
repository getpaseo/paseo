import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { isWorkspaceRootAgent } from "@/subagents/workspace-root-policy";
import { pickAttentionAgent } from "@/utils/agent-attention";
import {
  buildHostWorkspaceOpenRoute,
  buildHostWorkspaceRoute,
  decodeWorkspaceIdFromPathSegment,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";
import {
  normalizeWorkspaceOpaqueId,
  resolveWorkspaceMapKeyByIdentity,
} from "@/utils/workspace-identity";
import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { prepareWorkspaceTab, type PrepareWorkspaceTabDeps } from "@/utils/prepare-workspace-tab";
import type { WorkspaceTabPlacement } from "@/stores/workspace-layout-actions";

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
  placement?: WorkspaceTabPlacement;
}

export interface NavigateToWorkspaceDeps extends PrepareWorkspaceTabDeps {
  getSessionWorkspaces: (serverId: string) => Map<string, WorkspaceDescriptor> | null | undefined;
  getSessionAgents: (serverId: string) => Iterable<Agent>;
  isWorkspaceLayoutHydrated: () => boolean;
  getWorkspaceFocusedTarget: (workspaceKey: string) => WorkspaceTabTarget | null;
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
  const workspaces = deps.getSessionWorkspaces(input.serverId);
  const resolvedWorkspaceId = resolveWorkspaceMapKeyByIdentity({
    workspaces,
    workspaceId: input.workspaceId,
  });
  const shouldDeferAgentOpen = Boolean(
    input.target?.kind === "agent" && (!resolvedWorkspaceId || !deps.isWorkspaceLayoutHydrated()),
  );
  if (input.target) {
    if (!shouldDeferAgentOpen) {
      prepareWorkspaceTab({ ...input, target: input.target }, deps);
    }
  } else {
    const hostAgents = Array.from(deps.getSessionAgents(input.serverId));
    const agentsById = new Map(hostAgents.map((agent) => [agent.id, agent]));
    const workspaceAgents = resolvedWorkspaceId
      ? hostAgents.filter(
          (agent) => normalizeWorkspaceOpaqueId(agent.workspaceId) === resolvedWorkspaceId,
        )
      : [];
    const workspaceKey = `${input.serverId}:${resolvedWorkspaceId}`;
    const focusedTarget = deps.getWorkspaceFocusedTarget(workspaceKey);
    let attentionAgentId = pickAttentionAgent(workspaceAgents);
    if (
      !attentionAgentId &&
      deps.isWorkspaceLayoutHydrated() &&
      (!focusedTarget || focusedTarget.kind === "new_tab")
    ) {
      attentionAgentId =
        workspaceAgents
          .filter(
            (agent) =>
              !agent.archivedAt &&
              isWorkspaceRootAgent(agent, agentsById.get(agent.parentAgentId ?? "")),
          )
          .reduce<Agent | null>(
            (latest, agent) =>
              !latest || agent.lastActivityAt > latest.lastActivityAt ? agent : latest,
            null,
          )?.id ?? null;
    }
    if (attentionAgentId && resolvedWorkspaceId) {
      deps.openTab({
        workspaceKey: `${input.serverId}:${resolvedWorkspaceId}`,
        target: { kind: "agent", agentId: attentionAgentId },
        intent: "reveal",
      });
    }
  }

  const route =
    input.target?.kind === "agent" && shouldDeferAgentOpen
      ? buildHostWorkspaceOpenRoute(
          input.serverId,
          input.workspaceId,
          `agent:${input.target.agentId}`,
        )
      : buildHostWorkspaceRoute(input.serverId, input.workspaceId);
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
