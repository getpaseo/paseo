import { useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EditorTargetIdSchema, type EditorTargetId } from "@server/shared/messages";

const PREFERRED_EDITOR_STORAGE_KEY = "@paseo:preferred-editor";
const PREFERRED_EDITOR_QUERY_KEY = ["preferred-editor"];

async function loadPreferredEditor(): Promise<EditorTargetId | null> {
  const stored = await AsyncStorage.getItem(PREFERRED_EDITOR_STORAGE_KEY);
  if (!stored) {
    return null;
  }
  const parsed = EditorTargetIdSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

export function resolvePreferredEditorId(
  availableEditorIds: readonly EditorTargetId[],
  storedEditorId: EditorTargetId | null | undefined,
): EditorTargetId | null {
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
      queryClient.setQueryData(PREFERRED_EDITOR_QUERY_KEY, editorId);
      if (editorId) {
        await AsyncStorage.setItem(PREFERRED_EDITOR_STORAGE_KEY, editorId);
        return;
      }
      await AsyncStorage.removeItem(PREFERRED_EDITOR_STORAGE_KEY);
    },
    [queryClient],
  );

  return {
    preferredEditorId: data ?? null,
    isLoading: isPending,
    updatePreferredEditor,
  };
}
