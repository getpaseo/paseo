import { expect, test } from "vitest";
import { UsageSourceRegistry } from "./index.js";

function source(input: {
  id: string;
  discover?: () => Promise<unknown[]>;
  identify?: (value: unknown) => Promise<{ key: string; label?: string } | null>;
  fetch?: (value: unknown) => Promise<unknown>;
}) {
  return {
    id: input.id,
    label: input.id,
    discover: input.discover ?? (async () => []),
    identify:
      input.identify ??
      (async (value: unknown) => ({ key: (value as { account: string }).account })),
    fetch: input.fetch ?? (async () => ({ status: "available", windows: [] })),
  };
}

test("discovery preserves account IDs and updates input after token rotation", async () => {
  const registry = new UsageSourceRegistry();
  let token = "old";
  registry.register(
    source({
      id: "codex",
      discover: async () => [{ account: "work", token }],
      fetch: async (input) => ({
        status: "available",
        windows: [{ id: "token", label: (input as { token: string }).token }],
      }),
    }),
  );
  const first = await registry.listReports();
  expect(first.map((entry) => entry.id)).toEqual(["codex:work"]);
  expect(first[0]?.report.windows[0]?.label).toBe("old");
  token = "new";
  const refreshed = await registry.listReports({ forceRefresh: true });
  expect(refreshed.map((entry) => entry.id)).toEqual(["codex:work"]);
  expect(refreshed[0]?.report.windows[0]?.label).toBe("new");
});

test("coalesces per account, caches errors, and refreshes only requested IDs", async () => {
  let now = 0;
  const counts = new Map<string, number>();
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({
      id: "source",
      discover: async () => [{ account: "a" }, { account: "b" }],
      fetch: async (input) => {
        const account = (input as { account: string }).account;
        counts.set(account, (counts.get(account) ?? 0) + 1);
        if (account === "b") throw new Error("failed");
        return { status: "available", windows: [] };
      },
    }),
  );
  const first = await registry.listReports();
  expect(first.map((entry) => entry.id)).toEqual(["source:a", "source:b"]);
  expect(first[1]?.report.status).toBe("error");
  expect(await registry.listReports()).toEqual(first);
  expect(counts.get("a")).toBe(1);
  expect(counts.get("b")).toBe(1);
  now = 1000;
  const refreshed = await registry.listReports({
    reportIds: ["source:a", "missing:id"],
    forceRefresh: true,
  });
  expect(refreshed.map((entry) => entry.id)).toEqual(["source:a"]);
  expect(refreshed[0]?.fetchedAt).not.toBe(first[0]?.fetchedAt);
  expect(counts.get("a")).toBe(2);
  expect(counts.get("b")).toBe(1);
  now = 301_001;
  await registry.listReports({ reportIds: ["source:a"] });
  expect(counts.get("a")).toBe(3);
});

test("invalid keys become source errors and missing identities produce no report", async () => {
  const registry = new UsageSourceRegistry();
  registry.register(
    source({
      id: "source",
      discover: async () => [{ account: "bad:key" }, { account: "none" }],
      identify: async (input) => {
        const account = (input as { account: string }).account;
        return account === "none" ? null : { key: account };
      },
    }),
  );
  const reports = await registry.listReports();
  expect(reports.map((entry) => entry.id)).toEqual(["source:!error"]);
  expect(reports[0]?.report.status).toBe("error");
});

test("legacy listing uses oldest fetchedAt", async () => {
  let now = 1000;
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({ id: "source", discover: async () => [{ account: "a" }, { account: "b" }] }),
  );
  await registry.listReports();
  now = 2000;
  await registry.listReports({ reportIds: ["source:b"], forceRefresh: true });
  expect((await registry.listLegacyUsage()).fetchedAt).toBe(new Date(1000).toISOString());
});

test("concurrent requests for the same ID share one vendor fetch", async () => {
  let finish!: (report: unknown) => void;
  const response = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  let fetches = 0;
  const registry = new UsageSourceRegistry();
  registry.register(
    source({
      id: "coalesced",
      discover: async () => [{ account: "one" }],
      fetch: async () => {
        fetches++;
        return response;
      },
    }),
  );
  const first = registry.listReports();
  const second = registry.listReports();
  finish({ status: "available", windows: [] });
  const [one, two] = await Promise.all([first, second]);
  expect(one[0]).toBe(two[0]);
  expect(fetches).toBe(1);
});

test("source failure IDs cannot collide with an account named error", async () => {
  const registry = new UsageSourceRegistry();
  registry.register(
    source({
      id: "source",
      discover: async () => [{ account: "error" }, { account: "bad:key" }],
    }),
  );
  const reports = await registry.listReports();
  expect(reports).toHaveLength(2);
  expect(reports.find((entry) => entry.id === "source:error")?.report.status).toBe("available");
  expect(reports.find((entry) => entry.report.status === "error")?.id).toMatch(
    /^source:[^A-Za-z0-9._-]/,
  );
});

test("expired cached entries are pruned when a new report is written", async () => {
  let now = 0;
  const registry = new UsageSourceRegistry(() => now, 100);
  let account = "old";
  registry.register(source({ id: "source", discover: async () => [{ account }] }));
  await registry.listReports();
  await registry.listReports({ reportIds: ["source:old"] });
  now = 101;
  account = "new";
  await registry.listReports();
  await registry.listReports({ reportIds: ["source:new"] });
  const cache = Reflect.get(registry, "cache") as Map<string, unknown>;
  expect([...cache.keys()]).toEqual(["source:new"]);
});

test("discovery failures have an ID outside the account namespace", async () => {
  const registry = new UsageSourceRegistry();
  registry.register(
    source({
      id: "source",
      discover: async () => {
        throw new Error("discovery failed");
      },
    }),
  );
  const discovered = await registry.listReports();
  expect(discovered.map((entry) => entry.id)).toEqual(["source:!error"]);
});

test("legacy listing distinguishes labeled accounts and preserves unlabeled names", async () => {
  const registry = new UsageSourceRegistry(() => 1000);
  registry.register(
    source({
      id: "claude",
      discover: async () => [{ account: "work" }, { account: "personal" }, { account: "default" }],
      identify: async (input) => {
        const { account } = input as { account: string };
        return { key: account, label: account === "default" ? undefined : account };
      },
    }),
  );
  expect(
    (await registry.listLegacyUsage()).providers.map((provider) => provider.displayName),
  ).toEqual(["claude (work)", "claude (personal)", "claude"]);
});
