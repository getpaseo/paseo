import type { HostProfile } from "@/types/host-connection";
import { parseServerIdFromPathname } from "@/utils/host-routes";

export function resolveActiveHost({
  hosts,
  pathname,
}: {
  hosts: readonly HostProfile[];
  pathname: string;
}): HostProfile | null {
  const serverIdFromPath = parseServerIdFromPathname(pathname);
  if (serverIdFromPath) {
    const routeMatch = hosts.find((host) => host.serverId === serverIdFromPath);
    if (routeMatch) {
      return routeMatch;
    }
  }

  return hosts[0] ?? null;
}
