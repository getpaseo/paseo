import { useEffect, useMemo, useState } from "react";
import { searchPluginAttachments } from "@getpaseo/plugin/client/host";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { FileMentionRange } from "@/utils/file-mention-autocomplete";
import { useFetchQuery } from "@/data/query";
import { useInstalledPlugins } from "../registry";
import {
  attachmentMentionOptions,
  collectAttachmentMentionSources,
  resolveAttachmentMention,
} from "./mentions";

interface PluginAttachmentMentionsInput {
  serverId: string;
  client: DaemonClient | null;
  connected: boolean;
  mention: FileMentionRange | null;
}

export function usePluginAttachmentMentions(input: PluginAttachmentMentionsInput) {
  const plugins = useInstalledPlugins();
  const sources = useMemo(
    () => collectAttachmentMentionSources({ plugins, serverId: input.serverId }),
    [plugins, input.serverId],
  );
  const active = resolveAttachmentMention({ sources, mention: input.mention });
  const requestKey = active ? `${active.source.key}\0${active.query}` : null;
  const [debouncedRequestKey, setDebouncedRequestKey] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedRequestKey(requestKey), 180);
    return () => clearTimeout(timer);
  }, [requestKey]);
  const plugin = plugins.find(
    (candidate) =>
      candidate.serverId === input.serverId && candidate.id === active?.source.pluginId,
  );
  const isDebouncing = requestKey !== debouncedRequestKey;
  const search = useFetchQuery(
    {
      queryKey: [
        "plugin-attachment-search",
        input.serverId,
        active?.source.pluginId,
        active?.source.source.id,
        active?.query,
      ],
      queryFn: async () => {
        if (!input.client || !active) throw new Error("Plugin host is offline");
        const client = input.client;
        return searchPluginAttachments(
          active.source.source,
          (method, rpcInput) => client.invokePluginRpc(active.source.pluginId, method, rpcInput),
          active.query,
        );
      },
      enabled: input.connected && active !== null && !isDebouncing,
      retry: false,
      dataShape: "list",
      staleTimeMs: 30_000,
    },
    plugin?.queryClient,
  );
  const items =
    isDebouncing || search.isPlaceholderData || search.error ? [] : (search.data?.items ?? []);
  const options = attachmentMentionOptions({ sources, mention: input.mention, items });
  const scoped = active !== null;
  const isLoading = scoped && (isDebouncing || search.isFetching);
  const errorMessage = scoped && !isDebouncing && search.error ? search.error.message : undefined;
  return { options, scoped, isLoading, errorMessage, hasSources: sources.length > 0 };
}
