import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  Assistant,
  AssistantHistoryEntry,
  AssistantTemplate,
} from "@getpaseo/protocol/assistants";
import { useFetchQuery } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";
import { useAssistantSelectionStore } from "./assistant-selection-store";

export const assistantsQueryBaseKey = ["assistants"] as const;

export function assistantListQueryKey(serverId: string) {
  return [...assistantsQueryBaseKey, "list", serverId] as const;
}

export function assistantTemplateListQueryKey(serverId: string) {
  return [...assistantsQueryBaseKey, "templates", serverId] as const;
}

export function assistantHistoryQueryKey(serverId: string, assistantId: string) {
  return [...assistantsQueryBaseKey, "history", serverId, assistantId] as const;
}

const clientScopes = new WeakMap<DaemonClient, number>();
let nextClientScope = 1;

function useAssistantConnection(serverId: string | null) {
  const client = useSessionStore((state) => (serverId ? state.sessions[serverId]?.client : null));
  if (!client) return { client: null, clientScope: 0 };
  let scope = clientScopes.get(client);
  if (scope === undefined) {
    scope = nextClientScope++;
    clientScopes.set(client, scope);
  }
  return { client, clientScope: scope };
}

const LIST_STALE_TIME_MS = 5_000;
export const ASSISTANT_HISTORY_PAGE_SIZE = 50;

export function requireAssistantClient(serverId: string, unavailableMessage: string): DaemonClient {
  const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
  if (!client) {
    throw new Error(unavailableMessage);
  }
  return client;
}

export function hostSupportsAssistants(serverId: string): boolean {
  return useSessionStore.getState().sessions[serverId]?.serverInfo?.features?.assistants === true;
}

function sortBySeq(entries: readonly AssistantHistoryEntry[]): AssistantHistoryEntry[] {
  return [...entries].sort((left, right) => left.seq - right.seq);
}

export interface UseAssistantsResult {
  assistants: Assistant[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * The assistants the daemon holds for this principal. Loading the list is also
 * when a stale launcher selection gets dropped: the record is the only proof
 * the selected id still exists.
 */
export function useAssistants(serverId: string | null): UseAssistantsResult {
  const { t } = useTranslation();
  const { client, clientScope } = useAssistantConnection(serverId);
  const reconcile = useAssistantSelectionStore((state) => state.reconcile);
  const query = useFetchQuery({
    queryKey: [...assistantListQueryKey(serverId ?? ""), clientScope],
    enabled: serverId !== null,
    dataShape: "list",
    staleTimeMs: LIST_STALE_TIME_MS,
    queryFn: async () => {
      if (!client) throw new Error(t("common.errors.daemonClientUnavailable"));
      return await client.listAssistants();
    },
  });
  const assistants = query.isPlaceholderData ? null : (query.data ?? null);

  useEffect(() => {
    if (!serverId || !assistants) {
      return;
    }
    reconcile(
      serverId,
      assistants.map((assistant) => assistant.id),
    );
  }, [assistants, reconcile, serverId]);

  return {
    assistants: assistants ?? [],
    isLoading: query.isLoading || query.isPlaceholderData,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

/** The display name of one assistant, or null until the list has loaded or if it is gone. */
export function useAssistantName(
  serverId: string | null,
  assistantId: string | null,
): string | null {
  const { assistants } = useAssistants(assistantId ? serverId : null);
  if (!assistantId) {
    return null;
  }
  return assistants.find((assistant) => assistant.id === assistantId)?.name ?? null;
}

export interface UseAssistantTemplatesResult {
  templates: AssistantTemplate[];
  isLoading: boolean;
  error: Error | null;
}

export function useAssistantTemplates(serverId: string | null): UseAssistantTemplatesResult {
  const { t } = useTranslation();
  const { client, clientScope } = useAssistantConnection(serverId);
  const query = useFetchQuery({
    queryKey: [...assistantTemplateListQueryKey(serverId ?? ""), clientScope],
    enabled: serverId !== null,
    dataShape: "list",
    staleTimeMs: LIST_STALE_TIME_MS,
    queryFn: async () => {
      if (!client) throw new Error(t("common.errors.daemonClientUnavailable"));
      return await client.listAssistantTemplates();
    },
  });
  return {
    templates: query.isPlaceholderData ? [] : (query.data ?? []),
    isLoading: query.isLoading || query.isPlaceholderData,
    error: query.error,
  };
}

interface OlderHistoryPages {
  key: string;
  entries: AssistantHistoryEntry[];
  hasMore: boolean;
}

function historyPageState(
  older: OlderHistoryPages | null,
  latest: { entries: AssistantHistoryEntry[]; hasMore: boolean } | null,
  key: string,
) {
  const olderEntries = older?.key === key ? older.entries : [];
  const hasMore = older?.key === key ? older.hasMore : (latest?.hasMore ?? false);
  const oldestLoadedSeq = olderEntries[0]?.seq ?? latest?.entries[0]?.seq ?? null;
  return { olderEntries, hasMore, oldestLoadedSeq };
}

export interface UseAssistantHistoryResult {
  assistant: Assistant | null;
  /** Ascending by sequence, oldest loaded first. */
  entries: AssistantHistoryEntry[];
  hasMore: boolean;
  isLoading: boolean;
  isLoadingOlder: boolean;
  error: Error | null;
  loadOlder: () => Promise<void>;
  refetch: () => void;
}

/**
 * The newest page comes from the query cache so edits and compaction refresh
 * it through invalidation. Older pages are appended on demand and reset when
 * the assistant changes; they never go stale because sequence numbers below
 * the newest page do not change.
 */
export function useAssistantHistory(
  serverId: string | null,
  assistantId: string | null,
): UseAssistantHistoryResult {
  const { t } = useTranslation();
  const { client, clientScope } = useAssistantConnection(serverId);
  const queryServerId = serverId ?? "";
  const queryAssistantId = assistantId ?? "";
  const query = useFetchQuery({
    queryKey: [...assistantHistoryQueryKey(queryServerId, queryAssistantId), clientScope],
    enabled: serverId !== null && assistantId !== null,
    dataShape: "value",
    staleTimeMs: LIST_STALE_TIME_MS,
    queryFn: async () => {
      if (!client) throw new Error(t("common.errors.daemonClientUnavailable"));
      const page = await client.getAssistant({
        assistantId: queryAssistantId,
        limit: ASSISTANT_HISTORY_PAGE_SIZE,
      });
      return { assistant: page.assistant, entries: sortBySeq(page.history), hasMore: page.hasMore };
    },
  });
  const [older, setOlder] = useState<OlderHistoryPages | null>(null);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const loadingOlder = useRef(false);

  const latest = query.data ?? null;
  const pageKey = `${clientScope}:${serverId}:${assistantId}:${latest?.assistant.lastSeq ?? 0}`;
  const { olderEntries, oldestLoadedSeq, hasMore } = historyPageState(older, latest, pageKey);

  const loadOlder = useCallback(async () => {
    if (!serverId || !assistantId || !hasMore || oldestLoadedSeq === null || loadingOlder.current) {
      return;
    }
    loadingOlder.current = true;
    setIsLoadingOlder(true);
    try {
      if (!client) throw new Error(t("common.errors.daemonClientUnavailable"));
      const page = await client.getAssistant({
        assistantId,
        beforeSeq: oldestLoadedSeq,
        limit: ASSISTANT_HISTORY_PAGE_SIZE,
      });
      setOlder((current) => {
        const existing = current?.key === pageKey ? current.entries : [];
        return {
          key: pageKey,
          entries: [...sortBySeq(page.history), ...existing],
          hasMore: page.hasMore,
        };
      });
    } finally {
      loadingOlder.current = false;
      setIsLoadingOlder(false);
    }
  }, [assistantId, client, hasMore, oldestLoadedSeq, pageKey, serverId, t]);

  return {
    assistant: latest?.assistant ?? null,
    entries: [...olderEntries, ...(latest?.entries ?? [])],
    hasMore,
    isLoading: query.isLoading,
    isLoadingOlder,
    error: query.error,
    loadOlder,
    refetch: () => {
      void query.refetch();
    },
  };
}
