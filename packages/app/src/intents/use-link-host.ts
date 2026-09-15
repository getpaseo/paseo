import { useHostRegistryLoaded, useHosts } from "@/runtime/host-runtime";
import {
  useIsLastWorkspaceSelectionHydrated,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { resolveLinkHost, type LinkHostResolution } from "./automation-link";

/** Null until the host registry and the remembered workspace have both loaded. */
export function useLinkHost(requestedServerId: string | null): LinkHostResolution | null {
  const hosts = useHosts();
  const hostsLoaded = useHostRegistryLoaded();
  const lastSelection = useLastWorkspaceSelection();
  const lastSelectionLoaded = useIsLastWorkspaceSelectionHydrated();
  if (!hostsLoaded || !lastSelectionLoaded) {
    return null;
  }
  return resolveLinkHost({
    requestedServerId,
    hosts,
    lastServerId: lastSelection?.serverId ?? null,
  });
}
