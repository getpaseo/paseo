import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { replicaQueryOptions } from "./query";

function setup() {
  const queryClient = new QueryClient();
  const queryKey = ["replica", "value"] as const;
  let fetches = 0;
  const options = replicaQueryOptions({
    queryKey,
    pushEvent: "value_update",
    queryFn: async () => {
      fetches++;
      return `fetch-${fetches}`;
    },
  });
  return { queryClient, queryKey, options, fetchCount: () => fetches };
}

describe("replicaQueryOptions mount behavior", () => {
  it("does not refetch on mount while the cached value is not invalidated", async () => {
    const { queryClient, queryKey, options, fetchCount } = setup();
    queryClient.setQueryData(queryKey, "cached");

    const observer = new QueryObserver(queryClient, options);
    const unsubscribe = observer.subscribe(() => {});
    await Promise.resolve();

    expect(fetchCount()).toBe(0);
    expect(observer.getCurrentResult().data).toBe("cached");
    unsubscribe();
    queryClient.clear();
  });

  it("refetches on mount when the cached value was invalidated while unobserved", async () => {
    const { queryClient, queryKey, options, fetchCount } = setup();
    queryClient.setQueryData(queryKey, "cached");
    await queryClient.invalidateQueries({ queryKey, refetchType: "none" });
    expect(fetchCount()).toBe(0);

    const observer = new QueryObserver(queryClient, options);
    const unsubscribe = observer.subscribe(() => {});
    await queryClient.getQueryCache().find({ queryKey })?.promise;

    expect(fetchCount()).toBe(1);
    expect(observer.getCurrentResult().data).toBe("fetch-1");
    unsubscribe();
    queryClient.clear();
  });
});
