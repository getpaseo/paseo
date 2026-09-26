import { expect, test } from "vitest";
import { UsageSourceRegistry } from "./index.js";

const report = (key: string, count: number) => ({
  account: { key },
  status: "available" as const,
  windows: [{ id: "count", label: "Count", usedPct: count }],
});

test("caches by source and input for five minutes and forceRefresh bypasses it", async () => {
  let now = 0;
  let count = 0;
  const registry = new UsageSourceRegistry(() => now);
  registry.register({
    id: "fixture",
    label: "Fixture",
    discover: async () => [{ account: "a" }],
    fetch: async () => report("a", ++count),
  });
  expect((await registry.listReports())[0]?.report.windows[0]?.usedPct).toBe(1);
  expect((await registry.listReports())[0]?.report.windows[0]?.usedPct).toBe(1);
  expect((await registry.listReports({ forceRefresh: true }))[0]?.report.windows[0]?.usedPct).toBe(
    2,
  );
  now = 300_001;
  expect((await registry.listReports())[0]?.report.windows[0]?.usedPct).toBe(3);
});

test("coalesces concurrent fetches and dedupes accounts", async () => {
  let count = 0;
  const registry = new UsageSourceRegistry();
  registry.register({
    id: "fixture",
    label: "Fixture",
    discover: async () => [{ a: 1 }, { a: 2 }],
    fetch: async () => report("same", ++count),
  });
  const [first, second] = await Promise.all([
    registry.fetch("fixture", { a: 1 }),
    registry.fetch("fixture", { a: 1 }),
  ]);
  expect(first).toBe(second);
  expect(count).toBe(1);
  expect(await registry.listReports()).toHaveLength(1);
});

test("includes live session references and ignores unregistered sources", async () => {
  const registry = new UsageSourceRegistry();
  registry.register({
    id: "fixture",
    label: "Fixture",
    discover: async () => [{ account: "default" }],
    fetch: async (input) => report((input as { account: string }).account, 25),
  });
  const reports = await registry.listReports({
    references: [
      { source: "fixture", input: { account: "second" } },
      { source: "missing", input: {} },
    ],
  });
  expect(reports.map((entry) => entry.report.account.key)).toEqual(["default", "second"]);
  expect(await registry.fetchReference({ source: "missing", input: {} })).toBeNull();
});

test("drops expired cached inputs on a later write", async () => {
  let now = 0;
  const registry = new UsageSourceRegistry(() => now, 100);
  registry.register({
    id: "fixture",
    label: "Fixture",
    discover: async () => [],
    fetch: async (input) => report(String(input), 1),
  });
  await registry.fetch("fixture", "old");
  now = 101;
  await registry.fetch("fixture", "new");
  const cache = Reflect.get(registry, "cache") as Map<string, unknown>;
  expect(cache.size).toBe(1);
});

test("turns fetch and discovery failures into error reports", async () => {
  const registry = new UsageSourceRegistry();
  registry.register({
    id: "failure",
    label: "Failure",
    discover: async () => [{}],
    fetch: async () => {
      throw new Error("failed");
    },
  });
  registry.register({
    id: "discovery",
    label: "Discovery",
    discover: async () => {
      throw new Error("discovery failed");
    },
    fetch: async () => report("never", 0),
  });
  expect((await registry.listReports()).map((entry) => entry.report.status)).toEqual([
    "error",
    "error",
  ]);
});

test("maps discovered reports to the legacy provider usage response", async () => {
  const registry = new UsageSourceRegistry(() => Date.parse("2026-06-19T00:00:00.000Z"));
  registry.register({
    id: "fixture",
    label: "Fixture Source",
    discover: async () => [{}],
    fetch: async () => ({
      account: { key: "one" },
      status: "available",
      windows: [{ id: "weekly", label: "Weekly", usedPct: 42, headline: true }],
    }),
  });
  registry.register({
    id: "missing",
    label: "Missing Source",
    discover: async () => [{}],
    fetch: async () => ({ account: { key: "default" }, status: "unavailable", windows: [] }),
  });
  expect(await registry.listLegacyUsage()).toEqual({
    fetchedAt: "2026-06-19T00:00:00.000Z",
    providers: [
      {
        providerId: "fixture",
        displayName: "Fixture Source",
        status: "available",
        planLabel: null,
        windows: [{ id: "weekly", label: "Weekly", usedPct: 42, headline: true }],
        balances: [],
        details: [],
        error: null,
      },
      {
        providerId: "missing",
        displayName: "Missing Source",
        status: "unavailable",
        planLabel: null,
        windows: [],
        balances: [],
        details: [],
        error: null,
      },
    ],
  });
});
