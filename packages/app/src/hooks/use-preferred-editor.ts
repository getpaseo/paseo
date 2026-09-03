import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { layeredSettingsStorage } from "@/storage/settings-seed";
import { readValidatedString } from "@/storage/validated-storage";

type EditorTargetId = string;

const PREFERRED_EDITOR_STORAGE_KEY = "@paseo:preferred-editor";
const PREFERRED_EDITOR_QUERY_KEY = ["preferred-editor"];

async function loadPreferredEditor(): Promise<EditorTargetId | null> {
  return readValidatedString(
    layeredSettingsStorage,
    PREFERRED_EDITOR_STORAGE_KEY,
    z.string().trim().min(1),
  );
}

export function resolvePreferredEditorId(
  availableEditorIds: readonly EditorTargetId[],
  storedEditorId: EditorTargetId | null | undefined,
): EditorTargetId | null {
  if (storedEditorId === undefined) {
    return null;
  }
  if (
    storedEditorId &&
    availableEditorIds.some((availableEditorId) => availableEditorId === storedEditorId)
  ) {
    return storedEditorId;
  }
  return availableEditorIds[0] ?? null;
}

export function usePreferredEditor() {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery({
    queryKey: PREFERRED_EDITOR_QUERY_KEY,
    queryFn: loadPreferredEditor,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const updatePreferredEditor = useCallback(
    async (editorId: EditorTargetId | null) => {
      // Persisting can fail when a seed layer owns the value, so the optimistic cache write is
      // rolled back before the error reaches the caller.
      const prev =
        queryClient.getQueryData<EditorTargetId | null>(PREFERRED_EDITOR_QUERY_KEY) ?? null;
      queryClient.setQueryData(PREFERRED_EDITOR_QUERY_KEY, editorId);
      try {
        if (editorId) {
          await layeredSettingsStorage.setItem(PREFERRED_EDITOR_STORAGE_KEY, editorId);
          return;
        }
        await layeredSettingsStorage.removeItem(PREFERRED_EDITOR_STORAGE_KEY);
      } catch (err) {
        queryClient.setQueryData(PREFERRED_EDITOR_QUERY_KEY, prev);
        throw err;
      }
    },
    [queryClient],
  );

  return {
    preferredEditorId: isPending ? undefined : (data ?? null),
    isLoading: isPending,
    updatePreferredEditor,
  };
}
