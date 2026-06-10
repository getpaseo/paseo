import { Redirect, Slot, useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { useHosts } from "@/runtime/host-runtime";
import { resolveKnownHostRoute } from "@/utils/host-routes";

export default function HostRouteLayout() {
  return (
    <HostRouteBootstrapBoundary>
      <KnownHostRoute />
    </HostRouteBootstrapBoundary>
  );
}

function KnownHostRoute() {
  const params = useLocalSearchParams<{ serverId?: string | string[] }>();
  const hosts = useHosts();
  const routeServerId = typeof params.serverId === "string" ? params.serverId : null;
  const resolution = resolveKnownHostRoute({ routeServerId, hosts });

  if (resolution.kind === "redirect") {
    return <Redirect href={resolution.href} />;
  }

  return <Slot />;
}
