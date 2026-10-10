import { useMemo, useSyncExternalStore } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { createQueryDataStore } from "@/data/query-data-store";

export function useCachedQueryData<T>(queryKey: QueryKey): T[] {
  const client = useQueryClient();
  const store = useMemo(() => createQueryDataStore<T>(client, queryKey), [client, queryKey]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
