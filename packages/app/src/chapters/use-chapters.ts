import { useEffect, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ChapterComparison, ChapterState } from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useWorkingDiff } from "@/git/use-working-diff";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";

export interface ChaptersScope {
  serverId: string;
  workspaceId: string;
  cwd: string;
}
export function useChapters(scope: ChaptersScope) {
  const active = useRetainedPanelActive();
  const connected = useHostRuntimeIsConnected(scope.serverId);
  const client = useHostRuntimeClient(scope.serverId);
  const supported = useSessionStore(
    (state) => state.sessions[scope.serverId]?.serverInfo?.features?.chapters === true,
  );
  const { preferences } = useChangesPreferences();
  const working = useWorkingDiff({
    ...scope,
    ignoreWhitespace: preferences.hideWhitespace,
    enabled: active && supported,
  });
  const comparison = useMemo<ChapterComparison>(
    () => ({
      mode: working.diffMode,
      baseRef: working.baseRef,
      ignoreWhitespace: preferences.hideWhitespace,
    }),
    [working.diffMode, working.baseRef, preferences.hideWhitespace],
  );
  const queryKey = useMemo(
    () => ["chapters", scope.serverId, scope.cwd, comparison],
    [scope.serverId, scope.cwd, comparison],
  );
  const queryClient = useQueryClient();
  const enabled = active && supported && connected && working.isGit;
  const query = useFetchQuery({
    queryKey,
    enabled,
    dataShape: "value",
    staleTimeMs: 0,
    retry: false,
    refetchInterval: (currentQuery) =>
      currentQuery.state.data?.status === "generating" ? 1500 : 15000,
    queryFn: async () => {
      if (!client) throw new Error("Host disconnected");
      const previous = queryClient.getQueryData<ChapterState>(queryKey);
      return client.getChapters({
        cwd: scope.cwd,
        comparison,
        generate: true,
        regenerate: false,
        knownStory: previous?.story ?? undefined,
      });
    },
  });
  useEffect(() => {
    if (enabled && !working.isDiffLoading) void queryClient.invalidateQueries({ queryKey });
  }, [enabled, working.files, working.isDiffLoading, queryClient, queryKey]);
  const regeneration = useMutation({
    mutationKey: [...queryKey, "regenerate"],
    mutationFn: async () => {
      if (!client) throw new Error("Host disconnected");
      const requestedKey = queryKey;
      const state = await client.getChapters({
        cwd: scope.cwd,
        comparison,
        generate: true,
        regenerate: true,
      });
      return { queryKey: requestedKey, state };
    },
    onSuccess: (result) => queryClient.setQueryData(result.queryKey, result.state),
  });
  const state = query.data;
  const story = state?.story ?? null;
  const stale = Boolean(story && story.fingerprint !== state?.currentFingerprint);
  return {
    state,
    story,
    stale,
    supported,
    connected,
    working,
    pending:
      regeneration.isPending ||
      state?.status === "generating" ||
      query.isLoading ||
      working.isStatusLoading,
    error:
      regeneration.error?.message ??
      query.error?.message ??
      state?.error ??
      working.statusErrorMessage,
    regenerate: () => regeneration.mutate(),
  };
}
