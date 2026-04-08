import { useEffect } from "react";
import { useLocalSearchParams, usePathname, useRouter } from "expo-router";
import { useSessionStore } from "@/stores/session-store";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import {
  buildHostOpenProjectRoute,
  buildHostRootRoute,
  buildHostWorkspaceRoute,
} from "@/utils/host-routes";
import { prepareWorkspaceTab } from "@/utils/workspace-navigation";

const HOST_ROOT_REDIRECT_DELAY_MS = 300;

export default function HostIndexRoute() {
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

  useEffect(() => {
    if (preferencesLoading) {
      return;
    }
    if (!serverId) {
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
        ? Array.from(sessionAgents.values()).filter((agent) => !agent.archivedAt)
        : [];
      visibleAgents.sort(
        (left, right) => right.lastActivityAt.getTime() - left.lastActivityAt.getTime(),
      );

      const visibleWorkspaces = sessionWorkspaces ? Array.from(sessionWorkspaces.values()) : [];
      visibleWorkspaces.sort((left, right) => {
        const leftTime = left.activityAt?.getTime() ?? Number.NEGATIVE_INFINITY;
        const rightTime = right.activityAt?.getTime() ?? Number.NEGATIVE_INFINITY;
        return rightTime - leftTime;
      });

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
  }, [pathname, preferencesLoading, router, serverId, sessionAgents, sessionWorkspaces]);

  return null;
}
