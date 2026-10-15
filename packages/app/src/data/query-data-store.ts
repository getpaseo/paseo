import { matchQuery, type QueryClient, type QueryKey } from "@tanstack/react-query";

/** A bounded view of completed searches; the query cache owns expiry and in-flight work. */
export function createQueryDataStore<T>(client: QueryClient, queryKey: QueryKey) {
  let snapshot: T[] = [];
  return {
    subscribe: (listener: () => void) =>
      client.getQueryCache().subscribe((event) => {
        if (matchQuery({ queryKey }, event.query)) listener();
      }),
    getSnapshot: () => {
      const next = client
        .getQueryCache()
        .findAll({ queryKey })
        .filter((query) => query.state.data !== undefined && !query.state.isInvalidated)
        .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
        .slice(0, 20)
        .flatMap((query) => {
          const data = client.getQueryData<T>(query.queryKey);
          return data === undefined ? [] : [data];
        });
      if (next.length !== snapshot.length || next.some((data, index) => data !== snapshot[index])) {
        snapshot = next;
      }
      return snapshot;
    },
  };
}
