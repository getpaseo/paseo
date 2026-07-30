import { Redirect } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { isWeb } from "@/constants/platform";
import { WorkflowsScreen } from "@/screens/workflows-screen";

export default function WorkflowsRoute() {
  if (!isWeb) return <Redirect href="/" />;
  return (
    <HostRouteBootstrapBoundary>
      <WorkflowsScreen />
    </HostRouteBootstrapBoundary>
  );
}
