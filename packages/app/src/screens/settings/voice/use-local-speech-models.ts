import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { LocalSpeechModel } from "@getpaseo/protocol/speech/rpc-schemas";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { isLocalModelBusy } from "./voice-settings";

const DOWNLOAD_POLL_INTERVAL_MS = 1000;

const localSpeechModelsQueryKey = (serverId: string) => ["speech-local-models", serverId] as const;

export interface LocalSpeechModels {
  models: LocalSpeechModel[];
  isLoading: boolean;
  error: Error | null;
  refresh: () => void;
  download: (modelId: string) => Promise<void>;
  remove: (modelId: string) => Promise<void>;
}

// The daemon reports download progress through the list, so the list polls while any
// model is downloading or extracting.
export function useLocalSpeechModels(serverId: string): LocalSpeechModels {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const query = useFetchQuery({
    queryKey: localSpeechModelsQueryKey(serverId),
    enabled: Boolean(client && isConnected),
    dataShape: "list",
    staleTimeMs: 0,
    queryFn: () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      return client.listLocalSpeechModels();
    },
    refetchInterval: (current) =>
      current.state.data?.some(isLocalModelBusy) ? DOWNLOAD_POLL_INTERVAL_MS : false,
  });
  const { refetch } = query;

  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  const download = useCallback(
    async (modelId: string) => {
      if (!client) return;
      await client.downloadLocalSpeechModel(modelId);
      await refetch();
    },
    [client, refetch],
  );

  const remove = useCallback(
    async (modelId: string) => {
      if (!client) return;
      await client.deleteLocalSpeechModel(modelId);
      await refetch();
    },
    [client, refetch],
  );

  return {
    models: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    refresh,
    download,
    remove,
  };
}
