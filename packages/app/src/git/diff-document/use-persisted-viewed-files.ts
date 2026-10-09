import { useCallback, useMemo } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import {
  useIsMutating,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { readValidatedJson } from "@/storage/validated-storage";
import { useFetchQuery } from "@/data/query";
import {
  compactViewedFileRevisions,
  restoreViewedFiles,
  updateViewedFileRevisions,
  viewedFileRevision,
  ViewedFileRevisionsSchema,
  type ViewedFileRevisions,
  type ViewedFileUpdate,
} from "./viewed-files";

const EMPTY_REVISIONS: ViewedFileRevisions = {};

interface UsePersistedViewedFilesOptions {
  storageKey: string | null;
  files: readonly ParsedDiffFile[];
}

export function usePersistedViewedFiles({ storageKey, files }: UsePersistedViewedFilesOptions) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["working-diff-viewed-files", storageKey], [storageKey]);
  const options = {
    queryKey,
    enabled: storageKey !== null,
    networkMode: "always",
    queryFn: async () => {
      if (storageKey === null) return EMPTY_REVISIONS;
      const saved = await readValidatedJson(AsyncStorage, storageKey, ViewedFileRevisionsSchema);
      if (saved === null) return EMPTY_REVISIONS;
      const compact = compactViewedFileRevisions(saved);
      if (compact !== saved) await AsyncStorage.setItem(storageKey, JSON.stringify(compact));
      return compact;
    },
  } satisfies UseQueryOptions<ViewedFileRevisions>;
  const query = useFetchQuery({
    ...options,
    dataShape: "value",
    immutableWhen: () => true,
  });
  const mutation = useMutation({
    mutationKey: queryKey,
    networkMode: "always",
    scope: { id: storageKey ?? "commit-viewed-files" },
    mutationFn: async (update: ViewedFileUpdate) => {
      if (storageKey === null) return EMPTY_REVISIONS;
      const current = await queryClient.ensureQueryData(options);
      const next = updateViewedFileRevisions(current, update);
      await AsyncStorage.setItem(storageKey, JSON.stringify(next));
      queryClient.setQueryData(queryKey, next);
      return next;
    },
  });
  const isSaving = useIsMutating({ mutationKey: queryKey }) > 0;
  const revisions = query.data ?? EMPTY_REVISIONS;
  const viewedFiles = useMemo(() => restoreViewedFiles(revisions, files), [revisions, files]);
  const changedPaths = useMemo(
    () => Object.keys(revisions).filter((path) => !viewedFiles.has(path)),
    [revisions, viewedFiles],
  );
  const { mutate, reset } = mutation;
  const toggleFileViewed = useCallback(
    (file: ParsedDiffFile, onSuccess: (isViewed: boolean) => void) => {
      mutate(
        { kind: "toggle", file },
        { onSuccess: (next) => onSuccess(next[file.path] === viewedFileRevision(file)) },
      );
    },
    [mutate],
  );
  const invalidateViewedFiles = useCallback(
    (paths: readonly string[]) => {
      const invalidPaths = new Set(paths);
      const invalidEntries = Object.entries(revisions).filter(([path]) => invalidPaths.has(path));
      const invalidRevisions = Object.fromEntries(invalidEntries);
      mutate({ kind: "invalidate", revisions: invalidRevisions });
    },
    [mutate, revisions],
  );
  function retry() {
    if (query.isError) void query.refetch();
    reset();
  }
  const pendingFilePath =
    mutation.isPending && mutation.variables.kind === "toggle"
      ? mutation.variables.file.path
      : null;

  return {
    viewedFiles,
    changedPaths,
    isLoading: storageKey !== null && query.isPending,
    isSaving,
    pendingFilePath,
    error: query.error ?? mutation.error,
    isLoadError: query.isError,
    toggleFileViewed,
    invalidateViewedFiles,
    retry,
  };
}
