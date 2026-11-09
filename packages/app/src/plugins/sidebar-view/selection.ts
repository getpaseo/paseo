import { useCallback } from "react";
import { useFetchQuery } from "@/data/query";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useMutation, useQueryClient } from "@tanstack/react-query";

const key = "sidebar.view";
const queryKey = [key];

export interface SidebarViewStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
export type SidebarViewSelectionState =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "ready"; selection: string };

export function useSidebarViewSelection(storage: SidebarViewStorage = AsyncStorage) {
  const client = useQueryClient();
  const query = useFetchQuery({
    queryKey,
    queryFn: async () => (await storage.getItem(key)) ?? "default",
    dataShape: "value",
    immutableWhen: () => true,
  });
  const save = useMutation({
    mutationFn: (selection: string) => storage.setItem(key, selection),
    onSuccess: (_result, selection) => {
      client.setQueryData(queryKey, selection);
    },
  });
  let state: SidebarViewSelectionState;
  if (query.isPending) state = { status: "loading" };
  else if (query.isError) state = { status: "error", error: query.error };
  else state = { status: "ready", selection: query.data };
  const { refetch } = query;
  const reload = useCallback(() => {
    void refetch();
  }, [refetch]);
  return {
    state,
    reload,
    setSelection: save.mutate,
    pending: save.isPending,
    error: save.error,
  };
}
