import type { Href } from "expo-router";
import { buildHostRootRoute } from "@/utils/host-routes";

export function resolveOfferLinkNavigationRoute(profile: unknown): Href | null {
  const serverId = (profile as { serverId?: unknown } | null)?.serverId;
  if (typeof serverId !== "string" || !serverId) {
    return null;
  }

  // Android may redeliver the Activity's original pairing intent after the app
  // process is reclaimed. Enter through the host index so its startup policy can
  // restore a remembered workspace instead of always reopening project setup.
  return buildHostRootRoute(serverId);
}
