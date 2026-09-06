import { useMemo } from "react";
import { useFetchQuery } from "@/data/query";
import { useLiveVoiceAvailability } from "@/live-voice/live-voice-availability";
import { useSessionStore } from "@/stores/session-store";

const BACKEND_MODEL_CATALOG_STALE_TIME_MS = 5 * 60 * 1000;

/**
 * A backend-executor model the user can pin a call to. Thinking option ids come
 * with the model so the thinking picker only offers what the model supports.
 */
export interface LiveVoiceBackendModelOption {
  id: string;
  label: string;
  thinkingOptionIds: string[];
}

interface CatalogModel {
  id: string;
  label: string;
  thinkingOptions?: Array<{ id: string }> | undefined;
}

/**
 * Like the voice catalog: the setting is global but hosts can differ, so only
 * models every eligible host reports are offered. A model missing from the
 * intersection would still work — the host provider resolves unknown ids to
 * its default — but offering it would silently mean "default" on some
 * machines, which is a worse surprise than a shorter list.
 */
export function resolveLiveVoiceBackendModelOptions(
  catalogs: readonly (readonly CatalogModel[])[],
): LiveVoiceBackendModelOption[] {
  const availableCatalogs = catalogs.filter((models) => models.length > 0);
  if (availableCatalogs.length === 0) {
    return [];
  }
  const [first, ...rest] = availableCatalogs;
  if (!first) {
    return [];
  }
  return first
    .filter((model) => rest.every((models) => models.some((other) => other.id === model.id)))
    .map((model) => ({
      id: model.id,
      label: model.label,
      thinkingOptionIds: (model.thinkingOptions ?? []).map((option) => option.id),
    }));
}

export function useLiveVoiceBackendModelOptions(): LiveVoiceBackendModelOption[] {
  const availability = useLiveVoiceAvailability();
  const hostIds = useMemo(() => {
    if (availability.kind !== "available") {
      return [];
    }
    return availability.hosts.map((host) => host.serverId);
  }, [availability]);

  const catalogQuery = useFetchQuery({
    queryKey: ["liveVoiceBackendModelCatalog", ...hostIds],
    enabled: hostIds.length > 0,
    dataShape: "list",
    staleTimeMs: BACKEND_MODEL_CATALOG_STALE_TIME_MS,
    queryFn: async () => {
      const catalogs = await Promise.allSettled(
        hostIds.map(async (serverId) => {
          const session = useSessionStore.getState().sessions[serverId];
          const client = session?.client;
          if (!client) {
            throw new Error(`Live Voice host '${serverId}' disconnected`);
          }
          // COMPAT(liveVoiceHostProvider): added in v0.3.0, remove fallback
          // after 2027-02-28. Older daemons don't advertise which provider
          // hosts their calls.
          const hostProvider = session.serverInfo?.features?.liveVoiceHostProvider ?? "codex";
          const payload = await client.listProviderModels(hostProvider);
          return payload.models ?? [];
        }),
      );
      return catalogs.flatMap((catalog) => (catalog.status === "fulfilled" ? [catalog.value] : []));
    },
  });

  return useMemo(
    () => resolveLiveVoiceBackendModelOptions(catalogQuery.data ?? []),
    [catalogQuery.data],
  );
}
