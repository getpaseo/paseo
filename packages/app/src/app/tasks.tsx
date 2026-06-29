import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { TasksScreen } from "@/screens/tasks-screen";

export default function TasksRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <TasksScreen />
    </HostRouteBootstrapBoundary>
  );
}
