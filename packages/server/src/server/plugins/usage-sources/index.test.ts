import { expect, test } from "vitest";
import { UsageSourceRegistry } from "./index.js";
import { Usage as MuseUsage } from "../../../../../../plugins/muse-provider/server/usage.js";

test("Muse reports belong only to the session's account and remain available globally", async () => {
  const usage = new MuseUsage();
  const homeEnv = { HOME: "/usage/home" };
  const configEnv = { HOME: "/usage/home", XDG_CONFIG_HOME: "/usage/work" };
  const accountIds = [homeEnv, configEnv].map((env, index) => {
    const launch = { command: "muse", args: [], env };
    usage.attach(`session-${index}`, launch, async () => ({
      usage: {
        observedAtMs: 1700000000000,
        tier: "Pro",
        window: { usedPercent: 11, resetsAtMs: 1700018000000, windowDurationMins: 120 },
        weekly: { usedPercent: 22, resetsAtMs: 1700604800000 },
      },
    }));
    return `muse:${usage.remember(launch).account}`;
  });
  const sessions = new Map([
    ["claude", { provider: "claude", env: homeEnv, sessionKey: "claude" }],
    ["codex", { provider: "codex", env: configEnv, sessionKey: "codex" }],
    ["muse-home", { provider: "muse", env: homeEnv, sessionKey: "muse-home" }],
    ["muse-work", { provider: "muse", env: configEnv, sessionKey: "muse-work" }],
    ["muse-unknown", { provider: "muse", env: { HOME: "/usage/unknown" }, sessionKey: "unknown" }],
  ]);
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: (id) => sessions.has(id),
    usageSession: (id) => sessions.get(id) ?? null,
  });
  registry.register(usage.registration());

  expect((await registry.listReports()).map((report) => report.id)).toEqual(accountIds);
  expect(await registry.listReports({ agentId: "claude" })).toEqual([]);
  expect(await registry.listReports({ agentId: "codex" })).toEqual([]);
  for (const [index, agentId] of ["muse-home", "muse-work"].entries()) {
    const reports = await registry.listReports({ agentId });
    expect(reports.map((report) => report.id)).toEqual([accountIds[index]]);
    expect(reports[0]!.report.status).toBe("available");
  }
  expect(await registry.listReports({ agentId: "muse-unknown" })).toEqual([]);
  expect((await registry.listReports()).map((report) => report.id)).toEqual(accountIds);
});

function source(input: {
  id: string;
  discover?: () => Promise<Array<{ key: string; label?: string; input: unknown }>>;
  fetch?: (value: unknown) => Promise<unknown>;
}) {
  return {
    id: input.id,
    label: input.id,
    discover: input.discover ?? (async () => []),
    fetch: input.fetch ?? (async () => ({ status: "available", windows: [] })),
  };
}

test("discovery preserves account IDs and updates input after token rotation", async () => {
  const registry = new UsageSourceRegistry();
  let token = "old";
  registry.register(
    source({
      id: "codex",
      discover: async () => [{ key: "work", input: { token } }],
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
      discover: async () => ["a", "b"].map((account) => ({ key: account, input: { account } })),
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

test("legacy listing uses oldest fetchedAt", async () => {
  let now = 1000;
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({
      id: "source",
      discover: async () => ["a", "b"].map((account) => ({ key: account, input: { account } })),
    }),
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
      discover: async () => [{ key: "one", input: {} }],
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

test("rediscovery removes an old account from targeted refreshes", async () => {
  let now = 0;
  const registry = new UsageSourceRegistry(() => now, 100);
  let account = "old";
  registry.register(source({ id: "source", discover: async () => [{ key: account, input: {} }] }));
  await registry.listReports();
  await registry.listReports({ reportIds: ["source:old"] });
  now = 101;
  account = "new";
  await registry.listReports();
  await registry.listReports({ reportIds: ["source:new"] });
  expect(await registry.listReports({ reportIds: ["source:old"] })).toEqual([]);
});

test("discovery failures log once while other sources still report", async () => {
  const warnings: unknown[][] = [];
  const registry = new UsageSourceRegistry(Date.now, 300_000, {
    warn: (...args: unknown[]) => {
      warnings.push(args);
    },
  });
  const err = new Error("subprocess stopped");
  registry.register(
    source({
      id: "kimi",
      discover: async () => {
        throw err;
      },
    }),
  );
  registry.register(source({ id: "healthy", discover: async () => [{ key: "one", input: {} }] }));
  const updates: string[] = [];
  const reports = await registry.listReports({ onReport: (report) => updates.push(report.id) });
  expect(reports.map((report) => report.id)).toEqual(["healthy:one"]);
  expect(updates).toEqual(["healthy:one"]);
  expect(warnings).toEqual([[{ sourceId: "kimi", err }, "Usage source discovery failed"]]);
});

test("a failed fetch is logged as well as reported", async () => {
  const warnings: unknown[][] = [];
  const registry = new UsageSourceRegistry(Date.now, 300_000, {
    warn: (...args: unknown[]) => {
      warnings.push(args);
    },
  });
  const err = new Error("Rate limited by Claude. Try again in 38m.");
  registry.register(
    source({
      id: "claude",
      discover: async () => [{ key: "work", input: {} }],
      fetch: async () => {
        throw err;
      },
    }),
  );
  const [report] = await registry.listReports();
  expect(report?.report).toEqual({ status: "error", error: err.message });
  expect(warnings).toEqual([[{ sourceId: "claude", err }, "Usage fetch failed"]]);
});

test("legacy listing distinguishes labeled accounts and preserves unlabeled names", async () => {
  const registry = new UsageSourceRegistry(() => 1000);
  registry.register(
    source({
      id: "claude",
      discover: async () =>
        ["work", "personal", "default"].map((key) => ({
          key,
          label: key === "default" ? undefined : key,
          input: {},
        })),
    }),
  );
  expect(
    (await registry.listLegacyUsage()).providers.map((provider) => provider.displayName),
  ).toEqual(["claude (work)", "claude (personal)", "claude"]);
});

test("duplicate logins follow discovery order and fall back on unavailable, error and throws", async () => {
  for (const failure of ["unavailable", "error", "throw"]) {
    const registry = new UsageSourceRegistry();
    const calls: number[] = [];
    registry.register(
      source({
        id: "codex",
        discover: async () => [0, 1, 2].map((input) => ({ key: "same", input })),
        fetch: async (input) => {
          calls.push(Number(input));
          if (input === 0) {
            if (failure === "throw") throw new Error("revoked");
            return failure === "unavailable"
              ? { status: failure, problem: { kind: "rejected", status: 401 } }
              : { status: failure, error: "revoked" };
          }
          return {
            status: "available",
            windows: [{ id: "session", label: "Session", usedPct: 42 }],
          };
        },
      }),
    );
    const reports = await registry.listReports();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.report.status).toBe("available");
    expect(calls).toEqual([0, 1]);
  }
});

test("targeted refresh re-reads the login without discovering again", async () => {
  let discoveries = 0;
  let value = "old";
  const registry = new UsageSourceRegistry();
  registry.register(
    source({
      id: "source",
      discover: async () => {
        discoveries++;
        return [{ key: "original", input: {} }];
      },
      fetch: async () => ({ status: "available", windows: [{ id: "session", label: value }] }),
    }),
  );
  await registry.listReports();
  value = "new";
  const reports = await registry.listReports({
    reportIds: ["source:original"],
    forceRefresh: true,
  });
  expect(reports[0]?.report).toEqual({
    status: "available",
    windows: [{ id: "session", label: "new" }],
  });
  expect(discoveries).toBe(1);
});

test("a thrown fetch is an error card", async () => {
  const registry = new UsageSourceRegistry();
  registry.register(
    source({
      id: "source",
      discover: async () => [{ key: "one", input: {} }],
      fetch: async () => {
        throw new Error("Store deleted");
      },
    }),
  );
  expect((await registry.listReports())[0]?.report).toEqual({
    status: "error",
    error: "Store deleted",
  });
});

test("an unavailable login falls back to the next available login", async () => {
  const calls: unknown[] = [];
  const registry = new UsageSourceRegistry();
  registry.register(
    source({
      id: "source",
      discover: async () => [1, 2].map((input) => ({ key: "same", input })),
      fetch: async (input) => {
        calls.push(input);
        return input === 1
          ? {
              status: "unavailable",
              problem: { kind: "expired", expiresAt: "1970-01-01T00:00:00.000Z" },
            }
          : { status: "available", windows: [] };
      },
    }),
  );
  expect(
    (await registry.listReports()).map((entry) => ({ id: entry.id, report: entry.report })),
  ).toEqual([{ id: "source:same", report: { status: "available", windows: [] } }]);
  expect(calls).toEqual([1, 2]);
});

test("failed fallbacks preserve the final problem", async () => {
  const registry = new UsageSourceRegistry();
  registry.register(
    source({
      id: "source",
      discover: async () => [1, 2].map((input) => ({ key: "same", input })),
      fetch: async (input) => ({
        status: "unavailable",
        problem: { kind: "rejected", status: input === 1 ? 401 : 403 },
      }),
    }),
  );
  expect((await registry.listReports())[0]?.report).toEqual({
    status: "unavailable",
    problem: { kind: "rejected", status: 403 },
  });
});

test("session discovery reuses accounts, separates launches, and retains live agent reports globally", async () => {
  const sessions = new Map([
    ["one", { provider: "claude", env: { HOME: "/one" }, sessionKey: "launch-1" }],
    ["two", { provider: "claude", env: { HOME: "/two" }, sessionKey: "launch-2" }],
  ]);
  const existing = new Set(["one", "two", "closed"]);
  const discoveries: string[] = [];
  let fetches = 0;
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: (id) => existing.has(id),
    usageSession: (id) => sessions.get(id) ?? null,
  });
  registry.register({
    id: "claude",
    label: "Claude",
    discover: async (scope) => {
      discoveries.push(scope.kind === "global" ? "global" : scope.env.HOME);
      if (scope.kind === "global") return [{ key: "default", input: "default" }];
      return [{ key: scope.env.HOME === "/new" ? "new" : "same", input: scope.env.HOME }];
    },
    fetch: async () => {
      fetches++;
      return { status: "available", windows: [] };
    },
  });
  expect(await registry.listReports({ agentId: "closed" })).toEqual([]);
  expect((await registry.listReports({ agentId: "one" })).map((r) => r.id)).toEqual([
    "claude:same",
  ]);
  await registry.listReports({ agentId: "one" });
  await registry.listReports({ agentId: "two" });
  expect(discoveries).toEqual(["/one", "/two"]);
  expect(fetches).toBe(1);
  expect((await registry.listReports()).map((r) => r.id)).toEqual([
    "claude:default",
    "claude:same",
  ]);
  sessions.set("one", { provider: "claude", env: { HOME: "/new" }, sessionKey: "launch-3" });
  expect((await registry.listReports({ agentId: "one" })).map((r) => r.id)).toEqual(["claude:new"]);
  existing.delete("two");
  sessions.delete("two");
  expect((await registry.listReports()).map((r) => r.id)).toEqual(["claude:default", "claude:new"]);
  await expect(registry.listReports({ agentId: "missing" })).rejects.toThrow("Unknown agent");
  await expect(registry.listReports({ agentId: "one", reportIds: [] })).rejects.toThrow("agentId");
});

test("reports arrive independently and a hung fetch settles as an error before completion", async () => {
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, undefined, 25);
  let finishSlow!: (value: unknown) => void;
  const slow = new Promise<unknown>((resolve) => {
    finishSlow = resolve;
  });
  const reports: string[] = [];
  let firstReport!: () => void;
  const first = new Promise<void>((resolve) => {
    firstReport = resolve;
  });
  for (const id of ["slow", "fast", "also-fast"]) {
    registry.register(
      source({
        id,
        discover: async () => [{ key: "account", input: {} }],
        fetch: async () => (id === "slow" ? slow : { status: "available", windows: [] }),
      }),
    );
  }
  let complete = false;
  const request = registry
    .listReports({
      onReport: (entry) => {
        reports.push(entry.id);
        firstReport();
      },
    })
    .then((entries) => {
      complete = true;
      return entries;
    });
  await first;
  expect(reports).toEqual(["fast:account", "also-fast:account"]);
  expect(complete).toBe(false);
  const entries = await request;
  expect(reports).toEqual(["fast:account", "also-fast:account", "slow:account"]);
  expect(entries[0]?.report).toEqual({ status: "error", error: "Usage fetch timed out" });
  finishSlow({ status: "available", windows: [] });
  expect((await registry.listReports({ reportIds: ["slow:account"] }))[0]?.report).toEqual(
    entries[0]?.report,
  );
});
