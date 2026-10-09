// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { type ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { useReportRefresh } from "./queries";
import type { UsageReportEntry } from "./types";

const { listUsageReports } = vi.hoisted(() => ({ listUsageReports: vi.fn() }));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getClient: () => ({ listUsageReports }) }),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function entry(id: string): UsageReportEntry {
  return {
    id,
    sourceId: id.split(":")[0]!,
    sourceLabel: "Fixture",
    account: {},
    fetchedAt: "2026-01-01T00:00:00.000Z",
    report: { status: "available", windows: [] },
  };
}

test.each(["agent", "host", "missing host"])(
  "%s card refresh reconciles the account",
  async (scope) => {
    const personal = entry("claude:personal");
    const team = entry("claude:team");
    const codex = entry("codex:account");
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const agentId = scope === "agent" ? "agent" : undefined;
    const hostKey = ["usage", "host", "reports"];
    const key = agentId ? ["usage", "host", "agent", agentId] : hostKey;
    const updated = { ...personal, fetchedAt: "2026-01-01T00:01:00.000Z" };
    let refreshed = agentId ? [team, codex] : [updated];
    let expected = agentId ? [team, codex] : [updated, codex];
    if (scope === "missing host") {
      refreshed = [];
      expected = [codex];
    }
    queryClient.setQueryData(hostKey, [personal, codex]);
    queryClient.setQueryData(key, [personal, codex]);
    listUsageReports.mockResolvedValue({ reports: refreshed });
    function wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    }
    const { result, unmount } = renderHook(() => useReportRefresh("host", personal.id, agentId), {
      wrapper,
    });
    try {
      act(() => result.current.refresh());
      await waitFor(() => {
        expect(listUsageReports).toHaveBeenCalledWith(
          agentId
            ? { agentId, forceRefresh: true }
            : { reportIds: [personal.id], forceRefresh: true },
        );
        expect(queryClient.getQueryData(key)).toEqual(expected);
        expect(queryClient.getQueryState(hostKey)?.isInvalidated).toBe(scope !== "host");
        expect(result.current.refreshState).toBe("idle");
      });
    } finally {
      unmount();
      queryClient.clear();
    }
  },
);
