import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { isProviderModelsQueryLoading } from "./agent-status-bar.model-loading";

describe("isProviderModelsQueryLoading", () => {
  it("does not treat a disabled pending query as loading", () => {
    const queryClient = new QueryClient();
    const observer = new QueryObserver(queryClient, {
      queryKey: ["providerModels", "server-1", "__missing_provider__"],
      enabled: false,
      queryFn: async () => [],
    });

    const result = observer.getCurrentResult();

    expect(result.isPending).toBe(true);
    expect(result.isLoading).toBe(false);
    expect(result.isFetching).toBe(false);
    expect(isProviderModelsQueryLoading(result)).toBe(false);
  });

  it("treats an active fetch as loading", () => {
    expect(
      isProviderModelsQueryLoading({
        isLoading: false,
        isFetching: true,
      }),
    ).toBe(true);
  });
});
