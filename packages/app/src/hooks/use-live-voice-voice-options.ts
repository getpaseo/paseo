import { useMemo } from "react";
import { resolveLiveVoiceVoiceOptions } from "@/live-voice/live-voice-voice-catalog";
import { useFetchQuery } from "@/data/query";
import { useLiveVoiceAvailability } from "@/live-voice/live-voice-availability";
import { useSessionStore } from "@/stores/session-store";

const LIVE_VOICE_CATALOG_STALE_TIME_MS = 5 * 60 * 1000;

export function useLiveVoiceVoiceOptions(): string[] {
  const availability = useLiveVoiceAvailability();
  const catalogHostIds = useMemo(() => {
    if (availability.kind !== "available") {
      return [];
    }
    return availability.hosts
      .filter((host) => host.supportsVoiceCatalog)
      .map((host) => host.serverId);
  }, [availability]);

  const catalogQuery = useFetchQuery({
    queryKey: ["liveVoiceVoiceCatalog", ...catalogHostIds],
    enabled: catalogHostIds.length > 0,
    dataShape: "list",
    staleTimeMs: LIVE_VOICE_CATALOG_STALE_TIME_MS,
    queryFn: async () => {
      const catalogs = await Promise.allSettled(
        catalogHostIds.map(async (serverId) => {
          const client = useSessionStore.getState().sessions[serverId]?.client;
          if (!client) {
            throw new Error(`Live Voice host '${serverId}' disconnected`);
          }
          return await client.listLiveVoiceVoices();
        }),
      );
      return catalogs.flatMap((catalog) => (catalog.status === "fulfilled" ? [catalog.value] : []));
    },
  });

  return useMemo(() => resolveLiveVoiceVoiceOptions(catalogQuery.data ?? []), [catalogQuery.data]);
}
