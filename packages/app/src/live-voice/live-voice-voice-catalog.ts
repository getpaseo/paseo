import { useMemo } from "react";
import { FALLBACK_LIVE_VOICE_OPTIONS } from "@getpaseo/protocol/live-voice-voices";
import { useFetchQuery } from "@/data/query";
import { useLiveVoiceAvailability } from "@/live-voice/live-voice-availability";
import { useSessionStore } from "@/stores/session-store";

const LIVE_VOICE_CATALOG_STALE_TIME_MS = 5 * 60 * 1000;

function normalizeVoiceOptions(options: readonly string[]): string[] {
  const voices = options.map((voice) => voice.trim()).filter(Boolean);
  return Array.from(new Set(voices));
}

export function resolveLiveVoiceVoiceOptions(catalogs: readonly (readonly string[])[]): string[] {
  const availableCatalogs = catalogs
    .map(normalizeVoiceOptions)
    .filter((voices) => voices.length > 0);
  if (availableCatalogs.length === 0) {
    return [...FALLBACK_LIVE_VOICE_OPTIONS];
  }

  const [first, ...rest] = availableCatalogs;
  return rest.reduce((common, voices) => {
    const available = new Set(voices);
    return common.filter((voice) => available.has(voice));
  }, first ?? []);
}

export async function resolveLiveVoiceVoiceForCall(input: {
  selectedVoice: string | undefined;
  listVoices?: () => Promise<string[]>;
}): Promise<string | undefined> {
  const selectedVoice = input.selectedVoice?.trim();
  if (!selectedVoice) {
    return undefined;
  }

  let options: string[];
  try {
    options = input.listVoices ? await input.listVoices() : [...FALLBACK_LIVE_VOICE_OPTIONS];
  } catch {
    options = [...FALLBACK_LIVE_VOICE_OPTIONS];
  }
  return resolveLiveVoiceVoiceOptions([options]).includes(selectedVoice)
    ? selectedVoice
    : undefined;
}

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
