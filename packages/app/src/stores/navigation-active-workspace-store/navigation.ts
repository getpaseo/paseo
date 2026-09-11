import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
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
import { buildWorkspaceTabPersistenceKey, type WorkspaceTabTarget } from "@/workspace-tabs/model";
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
  /**
   * Runs a callback once the persisted workspace layout has hydrated (immediately when it
   * already has). Navigation that beats hydration defers work here rather than dropping it.
   */
  onWorkspaceLayoutHydrated: (callback: () => void) => void;
  /** Reveals a tab for the current visit without persisting the focus change. */
  revealEphemeralTab: (input: { workspaceKey: string; target: WorkspaceTabTarget }) => void;
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
    const workspaceAgents = resolvedWorkspaceId
      ? Array.from(deps.getSessionAgents(input.serverId)).filter(
          (agent) => normalizeWorkspaceOpaqueId(agent.workspaceId) === resolvedWorkspaceId,
        )
      : [];
    const attentionAgentId = pickAttentionAgent(workspaceAgents);
    // Keyed like the workspace screen keys it (from the route id, via
    // buildWorkspaceTabPersistenceKey), not like the session-store map: a map
    // key that differs from the route id would file the reveal where the screen
    // never looks.
    const attentionWorkspaceKey = attentionAgentId
      ? buildWorkspaceTabPersistenceKey({
          serverId: input.serverId,
          workspaceId: input.workspaceId,
        })
      : null;
    // Ephemeral, not a persisted reveal: the layout keeps the focus the user
    // left behind, so returning to the workspace restores their tab once the
    // attention flag clears or they move focus themselves. Deferred until the
    // persisted layout has hydrated — hydration's merge replaces the layout
    // wholesale, so an early reveal would open the tab only for the merge to
    // discard it — but deferred, not dropped: the user is navigating NOW
    // because an agent needs attention, and once hydration settles them on
    // their saved tab, nothing else would retry the reveal.
    if (attentionAgentId && attentionWorkspaceKey) {
      const reveal: { workspaceKey: string; target: WorkspaceTabTarget } = {
        workspaceKey: attentionWorkspaceKey,
        target: { kind: "agent", agentId: attentionAgentId },
      };
      if (deps.isWorkspaceLayoutHydrated()) {
        deps.revealEphemeralTab(reveal);
      } else {
        deps.onWorkspaceLayoutHydrated(() => deps.revealEphemeralTab(reveal));
      }
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
