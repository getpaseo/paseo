import { useMemo } from "react";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { resolvePaperclipWebBase, type PaperclipLinkConfig } from "./links";

const STALE_MS = 10 * 60 * 1000;

/** The board's issue prefixes and the address this client reaches Paperclip on; null without one. */
export function usePaperclipLinks(serverId: string | null | undefined): PaperclipLinkConfig | null {
  const id = serverId ?? "";
  const client = useHostRuntimeClient(id);
  const supported = useHostFeature(id, "paperclipLinks");
  const connection = useHostRuntimeSnapshot(id)?.activeConnection ?? null;
  const query = useFetchQuery({
    queryKey: ["paperclipLinks", id],
    enabled: Boolean(client && supported),
    dataShape: "value",
    staleTimeMs: STALE_MS,
    queryFn: async () => client!.getPaperclipLinks(),
  });
  const endpoint = connection?.type === "directTcp" ? connection.endpoint : null;
  return useMemo(() => {
    const links = query.data;
    if (!links || links.prefixes.length === 0) return null;
    return {
      webBaseUrl: resolvePaperclipWebBase(links.webBaseUrl, endpoint),
      prefixes: links.prefixes,
    };
  }, [endpoint, query.data]);
}
