// Legacy kanban route — redirects to the first project kanban
import { useEffect, useMemo } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { useSessionStore } from "@/stores/session-store";
import { useActiveOrgId } from "@/stores/active-org-store";
import { buildHostProjectKanbanRoute, buildHostRootRoute } from "@/utils/host-routes";

export default function KanbanRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <KanbanRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function KanbanRouteContent() {
  const params = useLocalSearchParams<{ serverId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const sessionWorkspaces = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.workspaces : undefined,
  );
  const activeOrgId = useActiveOrgId();
  const projectId = useMemo(() => {
    const workspaces = sessionWorkspaces ? Array.from(sessionWorkspaces.values()) : [];
    const scoped = workspaces.filter(
      (w) => !activeOrgId || !w.orgId || w.orgId === activeOrgId,
    );
    return scoped[0]?.projectId?.trim() || null;
  }, [sessionWorkspaces, activeOrgId]);

  useEffect(() => {
    if (!serverId) {
      router.replace("/");
      return;
    }
    if (projectId) {
      router.replace(buildHostProjectKanbanRoute(serverId, projectId));
      return;
    }
    router.replace(buildHostRootRoute(serverId));
  }, [projectId, serverId]);

  return null;
}
