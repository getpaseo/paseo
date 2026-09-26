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
