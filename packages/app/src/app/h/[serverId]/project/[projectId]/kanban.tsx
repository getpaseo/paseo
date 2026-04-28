import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { KanbanScreen } from "@/screens/kanban-screen";

export default function ProjectKanbanRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <ProjectKanbanRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function ProjectKanbanRouteContent() {
  const params = useLocalSearchParams<{ serverId?: string; projectId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const projectId = typeof params.projectId === "string" ? params.projectId : "";

  return <KanbanScreen serverId={serverId} projectId={projectId} />;
}
