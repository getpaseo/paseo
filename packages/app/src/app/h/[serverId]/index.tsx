import { useEffect } from "react";
import { useLocalSearchParams, usePathname, useRouter } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { useSessionStore } from "@/stores/session-store";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import {
  buildHostOpenProjectRoute,
  buildHostRootRoute,
  buildHostWorkspaceRoute,
} from "@/utils/host-routes";
import { prepareWorkspaceTab } from "@/utils/workspace-navigation";
import {
  isWorkspaceVisibleInDesktopWindow,
  useDesktopWorkspaceWindowState,
} from "@/desktop/window-workspace-state";

const HOST_ROOT_REDIRECT_DELAY_MS = 300;

export default function HostIndexRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <HostIndexRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function HostIndexRouteContent() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useLocalSearchParams<{ serverId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const { isLoading: preferencesLoading } = useFormPreferences();
  const sessionAgents = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.agents : undefined,
  );
  const sessionWorkspaces = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.workspaces : undefined,
  );
  const hasHydratedWorkspaces = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.hasHydratedWorkspaces ?? false : false,
  );
  const desktopWorkspaceWindowState = useDesktopWorkspaceWindowState();

  useEffect(() => {
    if (preferencesLoading) {
      return;
    }
    if (!serverId) {
      return;
    }
    if (!desktopWorkspaceWindowState.isReady) {
      return;
    }
    const rootRoute = buildHostRootRoute(serverId);
    if (pathname !== rootRoute && pathname !== `${rootRoute}/`) {
      return;
    }
    const timer = setTimeout(() => {
      if (pathname !== rootRoute && pathname !== `${rootRoute}/`) {
        return;
      }

      const visibleAgents = sessionAgents
        ? Array.from(sessionAgents.values()).filter((agent) => {
            if (agent.archivedAt) {
              return false;
            }
            if (!agent.cwd?.trim()) {
              return true;
            }
            return isWorkspaceVisibleInDesktopWindow(
              desktopWorkspaceWindowState,
              serverId,
              agent.cwd.trim(),
            );
          })
        : [];
      visibleAgents.sort(
        (left, right) => right.lastActivityAt.getTime() - left.lastActivityAt.getTime(),
      );

      const ownedWorkspaceIdsForWindow =
        desktopWorkspaceWindowState.windowId === null
          ? []
          : Object.entries(desktopWorkspaceWindowState.workspaceOwners)
              .filter(([workspaceKey, ownerWindowId]) => {
                return (
                  ownerWindowId === desktopWorkspaceWindowState.windowId &&
                  workspaceKey.startsWith(`${serverId}:`)
                );
              })
              .map(([workspaceKey]) => workspaceKey.slice(serverId.length + 1));
      if (ownedWorkspaceIdsForWindow.length > 0 && !hasHydratedWorkspaces) {
        return;
      }

      const visibleWorkspaces = sessionWorkspaces
        ? Array.from(sessionWorkspaces.values()).filter((workspace) =>
            isWorkspaceVisibleInDesktopWindow(
              desktopWorkspaceWindowState,
              serverId,
              workspace.id,
            ),
          )
        : [];

      const primaryAgent = visibleAgents[0];
      if (primaryAgent?.cwd?.trim()) {
        router.replace(
          prepareWorkspaceTab({
            serverId,
            workspaceId: primaryAgent.cwd.trim(),
            target: { kind: "agent", agentId: primaryAgent.id },
          }) as any,
        );
        return;
      }

      const primaryWorkspace = visibleWorkspaces[0];
      if (primaryWorkspace?.id?.trim()) {
        router.replace(buildHostWorkspaceRoute(serverId, primaryWorkspace.id.trim()));
        return;
      }

      router.replace(buildHostOpenProjectRoute(serverId));
    }, HOST_ROOT_REDIRECT_DELAY_MS);

    return () => clearTimeout(timer);
  }, [
    desktopWorkspaceWindowState,
    pathname,
    preferencesLoading,
    router,
    serverId,
    hasHydratedWorkspaces,
    sessionAgents,
    sessionWorkspaces,
  ]);

  return null;
}
