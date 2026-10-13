import { describe, expect, it } from "vitest";
import type { UsageReportEntry } from "@getpaseo/protocol/messages";
import { render } from "../../output/index.js";
import { createCli } from "../../cli.js";
import { runUsageCommand } from "./index.js";

const options = { daemonTarget: { kind: "endpoint" as const, host: "example.test:1234" } };
const reports: UsageReportEntry[] = [
  {
    id: "plugin.source:work.account",
    sourceId: "plugin.source",
    sourceLabel: "Plugin Source",
    account: { label: "Work" },
    fetchedAt: "2026-10-09T12:00:00Z",
    icon: "<svg />",
    report: {
      status: "available",
      planLabel: "Pro",
      windows: [
        {
          id: "5h",
          label: "Five hours",
          usedPct: 12.5,
          remainingPct: 87.5,
          resetsAt: "2026-10-09T17:00:00Z",
          runsOutAt: "2026-10-09T16:00:00Z",
          shortfallPct: 4.25,
        },
        { id: "week", label: "Weekly", usedPct: null, remainingPct: 0 },
        { id: "extra", label: "Extra", usedPct: 0 },
      ],
      balances: [
        {
          id: "credit",
          label: "Credit",
          used: 0,
          remaining: 2.5,
          limit: 10,
          unit: "usd",
          resetsAt: "2026-11-01T00:00:00Z",
        },
        { id: "requests", label: "Requests", remaining: null, unit: "requests" },
      ],
      details: [{ id: "tier", label: "Tier", value: "Enterprise" }],
    },
  },
  {
    id: "plugin.source:personal",
    sourceId: "plugin.source",
    sourceLabel: "Plugin Source",
    account: {},
    fetchedAt: "2026-10-09T12:00:00Z",
    report: {
      status: "unavailable",
      problem: { kind: "rejected", status: 401, refreshedBy: "codex login" },
    },
    loginErrors: [
      {
        harness: "Claude Code",
        report: {
          status: "unavailable",
          problem: { kind: "expired", expiresAt: "2026-10-08T00:00:00Z", refreshedBy: "claude" },
        },
      },
      {
        harness: "Codex",
        report: {
          status: "unavailable",
          problem: { kind: "rejected", status: 401, refreshedBy: "codex login" },
        },
      },
      { harness: "Other", report: { status: "error", error: "Login service failed" } },
    ],
  },
  {
    id: "other:broken",
    sourceId: "other",
    sourceLabel: "Other",
    account: {},
    fetchedAt: "2026-10-09T12:00:00Z",
    report: { status: "error", error: "Source failed" },
  },
  {
    id: "other:noquota",
    sourceId: "other",
    sourceLabel: "Other",
    account: {},
    fetchedAt: "2026-10-09T12:00:00Z",
    report: {
      status: "unavailable",
      problem: { kind: "no_quota", detail: "No quota for this plan" },
    },
  },
];

function host(entries = reports, supported = true) {
  const requests: Array<Parameters<NonNullable<Parameters<typeof runUsageCommand>[2]>>[0]> = [];
  const queries: Array<
    { agentId?: string; forceRefresh?: boolean; reportIds?: string[] } | undefined
  > = [];
  let closed = 0;
  return {
    requests,
    queries,
    get closed() {
      return closed;
    },
    connect: async (input: (typeof requests)[number]) => {
      requests.push(input);
      return {
        getLastServerInfoMessage: () => ({ features: { usageSources: supported } }),
        listUsageReports: async (query?: (typeof queries)[number]) => {
          queries.push(query);
          const selected = query?.reportIds
            ? entries.filter((entry) => query.reportIds!.includes(entry.id))
            : entries;
          return { requestId: "request", reports: selected };
        },
        close: async () => {
          closed++;
        },
      };
    },
  };
}

it("preserves complete JSON entries, numeric values and quiet full IDs", async () => {
  const daemon = host();
  const result = await runUsageCommand(options, { kind: "list" }, daemon.connect);
  expect(JSON.parse(render(result, { format: "json" }))).toEqual(reports);
  expect(render(result, { quiet: true })).toBe(reports.map((entry) => entry.id).join("\n"));
  expect(daemon.requests).toEqual([{ target: options.daemonTarget }]);
  expect(daemon.closed).toBe(1);
});

it("lists all windows, balances, missing values, failures and remedies", async () => {
  const result = await runUsageCommand(options, { kind: "list" }, host().connect);
  const text = render(result, { noColor: true });
  for (const expected of [
    "REPORT ID",
    "SOURCE",
    "ACCOUNT",
    "STATUS",
    "USAGE",
    "FETCHED",
    "Five hours: 12.5% used, 87.5% remaining",
    "Weekly: - used, 0% remaining",
    "Extra: 0% used, - remaining",
    "Credit: 0 used, 2.5 remaining, 10 limit (usd)",
    "Requests: - used, - remaining, - limit (requests)",
    "Login expired at 2026-10-08T00:00:00Z. Run claude",
    "Login rejected (HTTP 401). Run codex login",
    "Other: Login service failed",
    "Source failed",
    "No quota for this plan",
  ])
    expect(text).toContain(expected);
  expect(render(result, { noHeaders: true })).not.toContain("REPORT ID");
});

it("inspects exact opaque IDs and includes resets, forecasts, details and login failures", async () => {
  const daemon = host();
  const result = await runUsageCommand(
    options,
    { kind: "inspect", id: reports[0]!.id },
    daemon.connect,
  );
  expect(JSON.parse(render(result, { format: "json" }))).toEqual(reports[0]);
  const text = render(result);
  for (const expected of [
    "Source ID: plugin.source",
    "Plan: Pro",
    "Resets: 2026-10-09T17:00:00Z",
    "Runs out: 2026-10-09T16:00:00Z",
    "Shortfall: 4.25%",
    "Resets: -",
    "Resets: 2026-11-01T00:00:00Z",
    "Tier: Enterprise",
  ])
    expect(text).toContain(expected);
  const failure = await runUsageCommand(
    options,
    { kind: "inspect", id: reports[1]!.id },
    daemon.connect,
  );
  expect(render(failure)).toContain("Login failures:\n  Claude Code: Login expired at");
  expect(render(failure)).toContain("  Other: Login service failed");
});

it("discovers before inspecting, then refreshes only the selected report", async () => {
  const daemon = host();
  await runUsageCommand(
    { ...options, refresh: true },
    { kind: "inspect", id: reports[0]!.id },
    daemon.connect,
  );
  expect(daemon.queries).toEqual([undefined, { reportIds: [reports[0]!.id], forceRefresh: true }]);
});

it("rejects agent selection combined with inspect before connecting", async () => {
  const daemon = host();
  await expect(
    runUsageCommand(
      { ...options, agent: "agent-A" },
      { kind: "inspect", id: reports[0]!.id },
      daemon.connect,
    ),
  ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
  expect(daemon.requests).toEqual([]);
});

it("passes agent account selection and refresh without converting it to token consumption", async () => {
  const daemon = host();
  await runUsageCommand(
    { ...options, agent: "agent-123", refresh: true },
    { kind: "list" },
    daemon.connect,
  );
  expect(daemon.queries).toEqual([{ agentId: "agent-123", forceRefresh: true }]);
});

it("returns an empty array in JSON and explains empty discovery in human output", async () => {
  const result = await runUsageCommand(options, { kind: "list" }, host([]).connect);
  expect(render(result, { format: "json" })).toBe("[]");
  expect(render(result)).toBe("No usage reports returned");
  expect(render(result, { quiet: true })).toBe("");
});

it("rejects unknown IDs and prefixes and closes the client", async () => {
  const daemon = host();
  await expect(
    runUsageCommand(options, { kind: "inspect", id: "plugin.source:work" }, daemon.connect),
  ).rejects.toEqual({
    code: "REPORT_NOT_FOUND",
    message: "Unknown usage report: plugin.source:work",
  });
  expect(daemon.closed).toBe(1);
});

it("gates unsupported hosts before any request and closes the connection", async () => {
  const daemon = host(reports, false);
  await expect(runUsageCommand(options, { kind: "list" }, daemon.connect)).rejects.toMatchObject({
    code: "UNSUPPORTED_HOST",
  });
  expect(daemon.queries).toEqual([]);
  expect(daemon.closed).toBe(1);
});

it("propagates connection and request failures", async () => {
  await expect(
    runUsageCommand(options, { kind: "list" }, async () => {
      throw new Error("Connection failed");
    }),
  ).rejects.toThrow("Connection failed");
  let closed = false;
  const connect = async () => ({
    getLastServerInfoMessage: () => ({ features: { usageSources: true } }),
    listUsageReports: async () => {
      throw new Error("Request failed");
    },
    close: async () => {
      closed = true;
    },
  });
  await expect(runUsageCommand(options, { kind: "list" }, connect)).rejects.toThrow(
    "Request failed",
  );
  expect(closed).toBe(true);
});

describe("usage CLI registration", () => {
  it("registers default, ls and inspect with the accepted selectors", () => {
    const usage = createCli().commands.find((command) => command.name() === "usage")!;
    expect(usage.commands.map((command) => command.name())).toEqual(["ls", "inspect"]);
    expect(usage.helpInformation()).toContain("--agent <id>");
    expect(usage.commands[0]!.helpInformation()).toContain("--refresh");
    expect(usage.commands[1]!.helpInformation()).toContain("<report-id>");
  });
});
