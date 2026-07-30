import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { BacklogScreen } from "@/screens/backlog-screen";

function isCreateIntent(value: string | string[] | undefined): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => entry === "1" || entry === "true");
  }
  return value === "1" || value === "true";
}

export default function BacklogRoute() {
  const params = useLocalSearchParams<{
    serverId?: string;
    projectId?: string;
    name?: string;
    create?: string | string[];
  }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const projectId = typeof params.projectId === "string" ? params.projectId : "";
  const displayName = typeof params.name === "string" ? params.name : undefined;
  const openCreate = isCreateIntent(params.create);
  // Keep create intent out of the remount key so closing the form (and clearing
  // ?create=1) does not wipe local backlog state like search/scroll.
  const screenKey = JSON.stringify([serverId, projectId, displayName ?? null]);

  return (
    <HostRouteBootstrapBoundary>
      <BacklogScreen
        key={screenKey}
        serverId={serverId}
        projectId={projectId}
        displayName={displayName}
        openCreate={openCreate}
      />
    </HostRouteBootstrapBoundary>
  );
}
