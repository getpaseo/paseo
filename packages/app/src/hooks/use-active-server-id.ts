import { useMemo } from "react";
import { usePathname } from "expo-router";
import { useHosts } from "@/runtime/host-runtime";
import { resolveActiveHost } from "@/utils/active-host";

export function useActiveHost() {
  const pathname = usePathname();
  const hosts = useHosts();

  return useMemo(() => resolveActiveHost({ hosts, pathname }), [hosts, pathname]);
}

export function useActiveServerId(): string | null {
  return useActiveHost()?.serverId ?? null;
}
