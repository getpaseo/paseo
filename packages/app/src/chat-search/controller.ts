import { useState, useCallback } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
interface ChatSearchState {
  isActive: boolean;
  query: string;
  isSearching: boolean;
  matches: Awaited<ReturnType<DaemonClient["searchAgentTimeline"]>>["matches"];
  currentIndex: number;
  error: string | null;
  epoch: string | null;
}

export function useChatSearchController(agentId: string, daemonClient: DaemonClient | null) {
  const [state, setState] = useState<ChatSearchState>({
    isActive: false,
    query: "",
    isSearching: false,
    matches: [],
    currentIndex: -1,
    error: null,
    epoch: null,
  });
  const startSearch = useCallback(
    () =>
      setState((s) => ({
        ...s,
        isActive: true,
        query: "",
        matches: [],
        currentIndex: -1,
        error: null,
      })),
    [],
  );
  const closeSearch = useCallback(
    () =>
      setState((s) => ({
        ...s,
        isActive: false,
        query: "",
        matches: [],
        currentIndex: -1,
        error: null,
      })),
    [],
  );
  const performSearch = useCallback(
    async (query: string) => {
      setState((s) => ({ ...s, query, isSearching: true, error: null }));
      if (!query.trim() || !daemonClient) {
        setState((s) => ({ ...s, isSearching: false, matches: [], currentIndex: -1 }));
        return;
      }
      try {
        const res = await daemonClient.searchAgentTimeline(agentId, query, { limit: 100 });
        setState((s) => ({
          ...s,
          isSearching: false,
          matches: res.matches,
          currentIndex: res.matches.length > 0 ? 0 : -1,
          epoch: res.epoch,
        }));
      } catch (err) {
        setState((s) => ({ ...s, isSearching: false, error: String(err) }));
      }
    },
    [agentId, daemonClient],
  );
  const nextMatch = useCallback(
    () =>
      setState((s) => ({
        ...s,
        currentIndex: s.matches.length > 0 ? (s.currentIndex + 1) % s.matches.length : -1,
      })),
    [],
  );
  const prevMatch = useCallback(
    () =>
      setState((s) => ({
        ...s,
        currentIndex:
          s.matches.length > 0 ? (s.currentIndex - 1 + s.matches.length) % s.matches.length : -1,
      })),
    [],
  );
  return { state, startSearch, closeSearch, performSearch, nextMatch, prevMatch };
}
