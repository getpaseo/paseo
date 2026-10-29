import { expect, test } from "vitest";
import { UsageSourceRegistry } from "./index.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverSession as discoverCursorSession,
  fetchUsage as fetchCursorUsage,
} from "../../../../../../plugins/cursor-usage-source/server/usage.js";
import { inputSchema as cursorInputSchema } from "../../../../../../plugins/cursor-usage-source/shared/input.js";

test("#7142: host usage retains distinct Cursor accounts after their individual details are read", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-accounts-"));
  try {
    const sessions = new Map<
      string,
      { provider: string; sessionKey: string; env: Record<string, string> }
    >();
    const spends = new Map<string, number>();
    for (const [agentId, account, spend] of [
      ["a", "user-a", 100],
      ["b", "user-b", 200],
      ["a-copy", "user-a", 100],
    ] as const) {
      const configHome = join(root, agentId);
      const token = `e30.${Buffer.from(JSON.stringify({ sub: account, nonce: agentId })).toString("base64url")}.signature`;
      await mkdir(join(configHome, "cursor"), { recursive: true });
      await writeFile(
        join(configHome, "cursor", "auth.json"),
        JSON.stringify({ accessToken: token }),
      );
      spends.set(`Bearer ${token}`, spend);
      sessions.set(agentId, {
        provider: "cursor",
        sessionKey: agentId,
        env: { XDG_CONFIG_HOME: configHome },
      });
    }
    const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
      hasAgent: (id) => sessions.has(id),
      usageSession: (id) => sessions.get(id) ?? null,
    });
    const fetchApi: typeof fetch = async (_url, init) => {
      const authorization = new Headers(init?.headers).get("Authorization") ?? "";
      const spend = spends.get(authorization);
      if (spend === undefined) throw new Error("Unexpected fixture login");
      return new Response(JSON.stringify({ planUsage: { totalSpend: spend, limit: 1000 } }));
    };
    registry.register({
      id: "cursor",
      label: "Cursor",
      discover: (scope) =>
        scope.kind === "session" ? discoverCursorSession(scope, "linux") : Promise.resolve([]),
      fetch: (input) => fetchCursorUsage(cursorInputSchema.parse(input), fetchApi),
    });
    const spent = (reports: Awaited<ReturnType<typeof registry.listReports>>) =>
      reports.map((entry) => {
        if (entry.report.status !== "available")
          throw new Error("Expected available fixture usage");
        return entry.report.balances?.[0]?.used;
      });
    expect(spent(await registry.listReports({ agentId: "a" }))).toEqual([1]);
    expect(spent(await registry.listReports({ agentId: "b" }))).toEqual([2]);
    expect(spent(await registry.listReports({ agentId: "a-copy" }))).toEqual([1]);
    expect(spent(await registry.listReports())).toEqual([1, 2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("duplicate logins prefer discovery order across unavailable, error and thrown fetches", async () => {
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
    expect(calls).toEqual([0, 1, 2]);
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
  expect(fetches).toBe(2);
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

test("#6155: agent reports use only their session login despite host and sibling discoveries", async () => {
  const sessions = new Map([
    ["codex-agent", { provider: "codex", env: {}, sessionKey: "codex-launch" }],
    ["opencode-agent", { provider: "opencode", env: {}, sessionKey: "opencode-launch" }],
  ]);
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: (id) => sessions.has(id),
    usageSession: (id) => sessions.get(id) ?? null,
  });
  const codexError = { status: "error", error: "Codex usage API returned 500" };
  const expired = {
    status: "unavailable",
    problem: { kind: "expired", expiresAt: "2026-07-07T00:00:00.000Z", refreshedBy: "opencode" },
  };
  registry.register({
    id: "codex",
    label: "Codex",
    discover: async (scope) =>
      (scope.kind === "global" ? ["codex", "opencode"] : [scope.provider]).map((harness) => ({
        key: "same",
        harness,
        input: { harness },
      })),
    fetch: async (input) =>
      (input as { harness: string }).harness === "codex" ? codexError : expired,
  });
  await registry.listReports();
  await registry.listReports({ agentId: "opencode-agent" });
  expect((await registry.listReports({ agentId: "codex-agent" }))[0]?.report).toEqual(codexError);
});

test("all failed host logins retain each source-supplied harness and remedy", async () => {
  const registry = new UsageSourceRegistry();
  const failures = [
    { status: "error", error: "Codex usage API returned 500" },
    {
      status: "unavailable",
      problem: { kind: "expired", expiresAt: "2026-07-07T00:00:00.000Z", refreshedBy: "opencode" },
    },
    { status: "unavailable", problem: { kind: "rejected", status: 401, refreshedBy: "pi" } },
    { status: "unavailable", problem: { kind: "rejected", status: 403, refreshedBy: "omp" } },
  ];
  const harnesses = ["Codex", "OpenCode", "Pi", "OMP"];
  registry.register(
    source({
      id: "codex",
      discover: async () => harnesses.map((harness, input) => ({ key: "same", harness, input })),
      fetch: async (input) => failures[Number(input)],
    }),
  );
  const [entry] = await registry.listReports();
  expect(entry?.loginErrors).toEqual(
    harnesses.map((harness, index) => ({ harness, report: failures[index] })),
  );
});

test("a working agent login never uses another harness's failure or host fallback cache", async () => {
  const sessions = new Map([
    ["working", { provider: "codex", env: {}, sessionKey: "one" }],
    ["broken", { provider: "opencode", env: {}, sessionKey: "two" }],
  ]);
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: (id) => sessions.has(id),
    usageSession: (id) => sessions.get(id) ?? null,
  });
  const available = {
    status: "available",
    windows: [{ id: "weekly", label: "Weekly", usedPct: 31 }],
  };
  const error = { status: "error", error: "OpenCode login rejected. Run opencode to refresh it." };
  registry.register({
    id: "codex",
    label: "Codex",
    discover: async (scope) =>
      (scope.kind === "global" ? ["opencode", "codex"] : [scope.provider]).map((harness) => ({
        key: "same",
        harness,
        input: harness,
      })),
    fetch: async (input) => (input === "codex" ? available : error),
  });
  const [host] = await registry.listReports();
  expect(host?.report).toEqual(available);
  expect(host?.loginErrors).toBeUndefined();
  expect((await registry.listReports({ agentId: "working" }))[0]?.report).toEqual(available);
  expect((await registry.listReports({ agentId: "broken" }))[0]?.report).toEqual(error);
  expect(
    (await registry.listReports({ agentId: "broken", forceRefresh: true }))[0]?.report,
  ).toEqual(error);
  expect(
    (await registry.listReports({ reportIds: ["codex:same"], forceRefresh: true }))[0]?.report,
  ).toEqual(available);
});

test("concurrent host and agent requests never share a different login's pending fetch", async () => {
  let finish!: (report: unknown) => void;
  const slow = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: () => true,
    usageSession: () => ({ provider: "codex", env: {}, sessionKey: "launch" }),
  });
  registry.register({
    id: "codex",
    label: "Codex",
    discover: async (scope) => [{ key: "same", harness: "Codex", input: scope.kind }],
    fetch: async (input) =>
      input === "global" ? slow : { status: "error", error: "Session login failed" },
  });
  const host = registry.listReports();
  const [agent] = await registry.listReports({ agentId: "agent" });
  expect(agent?.report).toEqual({ status: "error", error: "Session login failed" });
  finish({ status: "available", windows: [] });
  expect((await host)[0]?.report.status).toBe("available");
});

test("duplicate logins across scopes appear only once in the host's errors", async () => {
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: () => true,
    usageSession: () => ({ provider: "codex", env: {}, sessionKey: "launch" }),
  });
  registry.register({
    id: "codex",
    label: "Codex",
    discover: async (scope) => [
      {
        key: "same",
        harness: "Codex",
        input:
          scope.kind === "global"
            ? { path: "/auth", kind: "file" }
            : { kind: "file", path: "/auth" },
      },
    ],
    fetch: async () => ({ status: "error", error: "Login failed" }),
  });
  await registry.listReports({ agentId: "agent" });
  expect((await registry.listReports())[0]?.loginErrors).toEqual([
    { harness: "Codex", report: { status: "error", error: "Login failed" } },
  ]);
});

test("a hung login records its own timeout and still tries the next login", async () => {
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, undefined, 25);
  registry.register({
    id: "codex",
    label: "Codex",
    discover: async () => [
      { key: "same", harness: "Codex", input: 0 },
      { key: "same", harness: "OpenCode", input: 1 },
    ],
    fetch: async (input) =>
      input === 0 ? new Promise(() => {}) : { status: "error", error: "Login rejected" },
  });
  expect((await registry.listReports())[0]?.loginErrors).toEqual([
    { harness: "Codex", report: { status: "error", error: "Usage fetch timed out" } },
    { harness: "OpenCode", report: { status: "error", error: "Login rejected" } },
  ]);
});

test("retains the last successful poll across failures, cache expiry, and recovery", async () => {
  let now = 0;
  let report: unknown = {
    status: "available",
    windows: [{ id: "week", label: "Weekly", usedPct: 42 }],
  };
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({
      id: "quota",
      discover: async () => [{ key: "account", input: {} }],
      fetch: async () => report,
    }),
  );
  registry.register(source({ id: "other", discover: async () => [{ key: "account", input: {} }] }));
  const [success] = await registry.listReports();
  now = 360_000;
  // An unrelated write evicts the expired fetch result, but must not discard its snapshot.
  await registry.listReports({ reportIds: ["other:account"], forceRefresh: true });
  report = { status: "error", error: "Rate limited" };
  const [failure] = await registry.listReports({ reportIds: ["quota:account"] });
  expect(failure).toMatchObject({
    fetchedAt: new Date(now).toISOString(),
    report,
    lastSuccessful: { fetchedAt: success!.fetchedAt, report: success!.report },
  });
  now += 360_000;
  const [repeated] = await registry.listReports({ reportIds: ["quota:account"] });
  expect(repeated?.lastSuccessful).toEqual(failure?.lastSuccessful);
  report = { status: "unavailable", problem: { kind: "no_quota", detail: "No quota" } };
  const [unavailable] = await registry.listReports({
    reportIds: ["quota:account"],
    forceRefresh: true,
  });
  expect(unavailable?.lastSuccessful).toEqual(failure?.lastSuccessful);
  now += 1000;
  report = { status: "available", windows: [{ id: "week", label: "Weekly", usedPct: 43 }] };
  const [recovered] = await registry.listReports({
    reportIds: ["quota:account"],
    forceRefresh: true,
  });
  expect(recovered?.report).toEqual(report);
  expect(recovered?.lastSuccessful).toBeUndefined();
  expect(recovered?.fetchedAt).toBe(new Date(now).toISOString());
});

test("successful history is isolated by login set and pruned when identities retire", async () => {
  let login = "old";
  let present = true;
  let available = true;
  const registry = new UsageSourceRegistry();
  const fixture = source({
    id: "source",
    discover: async () => (present ? [{ key: "same", input: login }] : []),
    fetch: async () =>
      available ? { status: "available", windows: [] } : { status: "error", error: "failed" },
  });
  registry.register(fixture);
  await registry.listReports();
  available = false;
  login = "new";
  expect((await registry.listReports({ forceRefresh: true }))[0]?.lastSuccessful).toBeUndefined();
  login = "old";
  expect((await registry.listReports({ forceRefresh: true }))[0]?.lastSuccessful).toBeUndefined();
  available = true;
  await registry.listReports({ forceRefresh: true });
  present = false;
  expect(await registry.listReports()).toEqual([]);
  present = true;
  available = false;
  expect((await registry.listReports())[0]?.lastSuccessful).toBeUndefined();
  available = true;
  await registry.listReports({ forceRefresh: true });
  registry.unregister("source");
  registry.register(fixture);
  available = false;
  expect((await registry.listReports())[0]?.lastSuccessful).toBeUndefined();
});

test("host fallback history never supplies an agent's failed login, and removed agents lose history", async () => {
  const sessions = new Map([["agent", { provider: "codex", env: {}, sessionKey: "one" }]]);
  let available = true;
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: (id) => sessions.has(id),
    usageSession: (id) => sessions.get(id) ?? null,
  });
  registry.register({
    id: "source",
    label: "Source",
    discover: async (scope) =>
      (scope.kind === "global" ? ["host", "agent"] : ["agent"]).map((input) => ({
        key: "same",
        input,
      })),
    fetch: async () =>
      available ? { status: "available", windows: [] } : { status: "error", error: "failed" },
  });
  await registry.listReports();
  available = false;
  expect((await registry.listReports({ agentId: "agent" }))[0]?.lastSuccessful).toBeUndefined();
  available = true;
  const [success] = await registry.listReports({ agentId: "agent", forceRefresh: true });
  available = false;
  expect(
    (await registry.listReports({ agentId: "agent", forceRefresh: true }))[0]?.lastSuccessful
      ?.report,
  ).toEqual(success?.report);
  sessions.delete("agent");
  await registry.listReports();
  sessions.set("agent", { provider: "codex", env: {}, sessionKey: "two" });
  expect((await registry.listReports({ agentId: "agent" }))[0]?.lastSuccessful).toBeUndefined();
});

test("a timed out poll retains successful values and late completion cannot replace the failure", async () => {
  let now = 1000;
  let finish!: (value: unknown) => void;
  let slow = false;
  const registry = new UsageSourceRegistry(() => now, 300_000, undefined, undefined, 10);
  registry.register(
    source({
      id: "source",
      discover: async () => [{ key: "same", input: {} }],
      fetch: async () =>
        slow
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : { status: "available", windows: [] },
    }),
  );
  const [success] = await registry.listReports();
  now = 2000;
  slow = true;
  const [failure] = await registry.listReports({ forceRefresh: true });
  expect(failure?.report).toEqual({ status: "error", error: "Usage fetch timed out" });
  expect(failure?.lastSuccessful).toEqual({
    fetchedAt: success?.fetchedAt,
    report: success?.report,
  });
  finish({ status: "available", windows: [{ id: "late", label: "Late" }] });
  expect((await registry.listReports())[0]).toEqual(failure);
});

test("attempt ordering keeps its timestamp while retained freshness records successful completion", async () => {
  let now = 1000;
  let available = true;
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({
      id: "source",
      discover: async () => [{ key: "same", input: {} }],
      fetch: async () => {
        if (available) now = 2000;
        return available
          ? { status: "available", windows: [] }
          : { status: "error", error: "failed" };
      },
    }),
  );
  const [success] = await registry.listReports();
  expect(success?.fetchedAt).toBe(new Date(1000).toISOString());
  expect(success?.successfulAt).toBe(new Date(2000).toISOString());
  available = false;
  now = 3000;
  const [failure] = await registry.listReports({ forceRefresh: true });
  expect(failure?.fetchedAt).toBe(new Date(3000).toISOString());
  expect(failure?.lastSuccessful?.fetchedAt).toBe(success?.successfulAt);
});

test("failed discovery preserves history until discovery confirms account removal", async () => {
  let discoveryFails = false;
  let present = true;
  let available = true;
  const registry = new UsageSourceRegistry(() => 1000, 300_000, { warn: () => {} });
  registry.register(
    source({
      id: "source",
      discover: async () => {
        if (discoveryFails) throw new Error("Login store temporarily unavailable");
        return present ? [{ key: "account", input: {} }] : [];
      },
      fetch: async () =>
        available
          ? { status: "available", windows: [{ id: "weekly", label: "Weekly", usedPct: 42 }] }
          : { status: "error", error: "Rate limited" },
    }),
  );
  const [success] = await registry.listReports();
  available = false;
  discoveryFails = true;
  const [duringDiscoveryFailure] = await registry.listReports({ forceRefresh: true });
  expect(duringDiscoveryFailure?.lastSuccessful).toEqual({
    fetchedAt: success?.successfulAt,
    report: success?.report,
  });
  discoveryFails = false;
  const [afterDiscoveryRecovery] = await registry.listReports({ forceRefresh: true });
  expect(afterDiscoveryRecovery?.lastSuccessful).toEqual(duringDiscoveryFailure?.lastSuccessful);
  expect(afterDiscoveryRecovery?.report).toEqual({ status: "error", error: "Rate limited" });
  present = false;
  expect(await registry.listReports()).toEqual([]);
  present = true;
  expect((await registry.listReports())[0]?.lastSuccessful).toBeUndefined();
});
