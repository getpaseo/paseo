/** @vitest-environment jsdom */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProfileFormModel } from "./profile-form-model";
import { useAgentProfileFormCatalog } from "./use-profile-form-inputs";

const snapshot = vi.hoisted(() => ({
  entries: [] as unknown[],
  refresh: vi.fn(async () => undefined),
}));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({
    entries: snapshot.entries,
    isLoading: false,
    isFetching: false,
    isRefreshing: false,
    error: null,
    supportsSnapshot: true,
    refresh: snapshot.refresh,
    refetchIfStale: () => {},
  }),
}));

function createFormModel(applyProviderCatalog: (entries: unknown[]) => void) {
  return { applyProviderCatalog } as unknown as AgentProfileFormModel;
}

describe("agent profile form catalog", () => {
  beforeEach(() => {
    snapshot.entries = [];
    snapshot.refresh.mockClear();
  });

  it("refreshes the host snapshot once so workspace-discovered modes reach the form", () => {
    const model = createFormModel(vi.fn());
    const { rerender } = renderHook(() => useAgentProfileFormCatalog({ serverId: "host", model }));
    expect(snapshot.refresh).toHaveBeenCalledTimes(1);
    rerender();
    expect(snapshot.refresh).toHaveBeenCalledTimes(1);
  });

  it("hands the host entries to the form", () => {
    const entry = { provider: "opencode", label: "OpenCode", modes: [{ id: "review" }] };
    snapshot.entries = [entry];
    const applyProviderCatalog = vi.fn();
    renderHook(() =>
      useAgentProfileFormCatalog({
        serverId: "host",
        model: createFormModel(applyProviderCatalog),
      }),
    );
    expect(applyProviderCatalog).toHaveBeenCalledWith([entry]);
  });
});
