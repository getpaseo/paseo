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

export interface EphemeralTabReveal {
  workspaceKey: string;
  target: WorkspaceTabTarget;
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
  revealEphemeralTab: (input: EphemeralTabReveal) => void;
  /**
   * Holds a reveal whose layout has not hydrated yet, without opening its tab. The entry is
   * memory-only, so hydration keeps it, and leaving the workspace clears it like any reveal.
   */
  holdEphemeralTab: (input: EphemeralTabReveal) => void;
  /**
   * Settles a held reveal after hydration: reveals it, or drops it when `reveal` is false. Does
   * nothing once the entry no longer holds this target — the visit ended or a newer reveal won.
   */
  settleHeldEphemeralTab: (input: EphemeralTabReveal & { reveal: boolean }) => void;
  /**
   * The workspace most recently navigated to or shown. App-wide routes (settings) leave it
   * unchanged, so it cannot tell on its own whether the user is still on that workspace.
   */
  getLastWorkspaceSelection: () => ActiveWorkspaceSelection | null;
  rememberLastWorkspace: (selection: ActiveWorkspaceSelection) => void;
  navigateToRoute: (route: string) => void;
}

export interface NavigateToLastWorkspaceDeps extends NavigateToWorkspaceDeps {}

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
      const reveal: EphemeralTabReveal = {
        workspaceKey: attentionWorkspaceKey,
        target: { kind: "agent", agentId: attentionAgentId },
      };
      if (deps.isWorkspaceLayoutHydrated()) {
        deps.revealEphemeralTab(reveal);
      } else {
        // Hydration can finish after the user has moved on, and a reveal
        // installed then would ambush their next visit. So the target is held
        // now and only settled at hydration: the workspace screen clears a held
        // entry when the user leaves — for any route, settings included — and
        // settling an entry that is gone does nothing. The selection check
        // covers the one departure the screen cannot see: moving on to another
        // workspace before this one's screen mounted.
        deps.holdEphemeralTab(reveal);
        const selection = { serverId: input.serverId, workspaceId: input.workspaceId };
        deps.onWorkspaceLayoutHydrated(() => {
          const current = deps.getLastWorkspaceSelection();
          deps.settleHeldEphemeralTab({
            ...reveal,
            reveal:
              current?.serverId === selection.serverId &&
              current.workspaceId === selection.workspaceId,
          });
        });
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
