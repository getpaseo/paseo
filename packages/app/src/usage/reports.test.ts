import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { QueryClient } from "@tanstack/react-query";
import { expect, test } from "vitest";
import { agentUsageQueryKey, refreshReport, usageReportsQueryKey } from "./reports";
import type { UsageReportEntry } from "./types";

class UsageClient implements Pick<DaemonClient, "listUsageReports"> {
  readonly requests: Parameters<DaemonClient["listUsageReports"]>[0][] = [];

  constructor(
    private readonly response: Promise<Awaited<ReturnType<DaemonClient["listUsageReports"]>>>,
  ) {}

  listUsageReports(options: Parameters<DaemonClient["listUsageReports"]>[0]) {
    this.requests.push(options);
    return this.response;
  }
}

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

const personal = entry("claude:personal");
const team = entry("claude:team");
const codex = entry("codex:account");
const updated = { ...personal, fetchedAt: "2026-01-01T00:01:00.000Z" };
const hostKey = usageReportsQueryKey("host");
const agentKey = agentUsageQueryKey("host", "agent");

test.each([
  {
    scope: "agent",
    agentId: "agent",
    key: agentKey,
    refreshed: [team, codex],
    expected: [team, codex],
    request: { agentId: "agent", forceRefresh: true },
    invalidateHost: true,
  },
  {
    scope: "host",
    agentId: undefined,
    key: hostKey,
    refreshed: [updated],
    expected: [updated, codex],
    request: { reportIds: [personal.id], forceRefresh: true },
    invalidateHost: false,
  },
  {
    scope: "missing host",
    agentId: undefined,
    key: hostKey,
    refreshed: [],
    expected: [codex],
    request: { reportIds: [personal.id], forceRefresh: true },
    invalidateHost: true,
  },
])(
  "$scope card refresh reconciles the account",
  async ({ agentId, key, refreshed, expected, request, invalidateHost }) => {
    const queryClient = new QueryClient();
    const otherHostKey = usageReportsQueryKey("other-host");
    const otherAgentKey = agentUsageQueryKey("host", "other-agent");
    for (const queryKey of [hostKey, agentKey, otherHostKey, otherAgentKey]) {
      queryClient.setQueryData(queryKey, [personal, codex]);
    }
    const client = new UsageClient(Promise.resolve({ requestId: "refresh", reports: refreshed }));
    try {
      await refreshReport({
        client,
        queryClient,
        serverId: "host",
        reportId: personal.id,
        agentId,
      });

      expect(client.requests).toEqual([request]);
      expect(queryClient.getQueryData(key)).toEqual(expected);
      expect(queryClient.getQueryState(hostKey)?.isInvalidated).toBe(invalidateHost);
      expect(queryClient.getQueryState(agentKey)?.isInvalidated).toBe(false);
      for (const untouched of [otherHostKey, otherAgentKey]) {
        expect(queryClient.getQueryData(untouched)).toEqual([personal, codex]);
        expect(queryClient.getQueryState(untouched)?.isInvalidated).toBe(false);
      }
    } finally {
      queryClient.clear();
    }
  },
);

test("a failed refresh preserves the previous reports and propagates the error", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(hostKey, [personal, codex]);
  const error = new Error("Host disconnected");
  const client = new UsageClient(Promise.reject(error));
  try {
    await expect(
      refreshReport({ client, queryClient, serverId: "host", reportId: personal.id }),
    ).rejects.toBe(error);
    expect(queryClient.getQueryData(hostKey)).toEqual([personal, codex]);
    expect(queryClient.getQueryState(hostKey)?.isInvalidated).toBe(false);
  } finally {
    queryClient.clear();
  }
});
