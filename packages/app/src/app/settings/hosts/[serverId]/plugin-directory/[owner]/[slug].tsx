import { useMemo } from "react";

import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import SettingsScreen from "@/screens/settings-screen";

/** A plugin directory listing's page, by its `owner/slug` ID. */
export default function PluginListingRoute() {
  const { serverId, owner, slug } = useLocalSearchParams<{
    serverId: string;
    owner: string;
    slug: string;
  }>();
  const view = useMemo(
    () => ({ kind: "pluginListing" as const, serverId, listingId: `${owner}/${slug}` }),
    [serverId, owner, slug],
  );
  return (
    <HostRouteBootstrapBoundary>
      <SettingsScreen view={view} />
    </HostRouteBootstrapBoundary>
  );
}
