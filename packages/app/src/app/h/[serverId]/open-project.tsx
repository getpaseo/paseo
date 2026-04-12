import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { OpenProjectScreen } from "@/screens/open-project-screen";

export default function HostOpenProjectRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <HostOpenProjectRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function HostOpenProjectRouteContent() {
  const params = useLocalSearchParams<{ serverId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";

  return <OpenProjectScreen serverId={serverId} />;
}
