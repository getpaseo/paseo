import { expect, test, vi } from "vitest";
import type { UsageReportEntry } from "@getpaseo/protocol/messages";
import { UsageSourceRegistry } from "./index.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discover as discoverClaude,
  fetchUsage as fetchClaudeUsage,
} from "../../../../../../plugins/claude-usage-source/server/usage.js";
import { inputSchema as claudeInputSchema } from "../../../../../../plugins/claude-usage-source/shared/input.js";
import {
  discover as discoverCursor,
  discoverSession as discoverCursorSession,
  fetchUsage as fetchCursorUsage,
} from "../../../../../../plugins/cursor-usage-source/server/usage.js";
import { inputSchema as cursorInputSchema } from "../../../../../../plugins/cursor-usage-source/shared/input.js";

test("switching a shared Claude home replaces the account without borrowing its usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-accounts-"));
  try {
    const defaultHome = join(root, "default");
    const otherHome = join(root, "other");
    await Promise.all([mkdir(defaultHome), mkdir(otherHome)]);
    const login = (home: string, token: string) =>
      writeFile(
        join(home, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: token } }),
      );
    await login(defaultHome, "old");

    const sessions = new Map([
      [
        "default",
        {
          sessionKey: "first",
          provider: "claude",
          env: { HOME: root, CLAUDE_CONFIG_DIR: defaultHome },
        },
      ],
    ]);
    const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
      hasAgent: (id) => sessions.has(id),
      usageSession: (id) => sessions.get(id) ?? null,
    });
    const usageTokens: string[] = [];
    const fetchApi: typeof fetch = async (url, init) => {
      const token = new Headers(init?.headers).get("Authorization")?.split(" ")[1];
      if (!token) throw new Error("Missing fixture token");
      const account = token === "rotated" ? "old" : token;
      if (String(url).endsWith("/profile")) {
        return Response.json({
          account: { uuid: account, email: account + "@example.com" },
          organization: { uuid: "org" },
        });
      }
      usageTokens.push(token);
      return Response.json({ five_hour: { utilization: account === "old" ? 100 : 17 } });
    };
    registry.register({
      id: "claude",
      label: "Claude",
      discover: (scope) =>
        discoverClaude(
          scope,
          {
            home: root,
            env: { CLAUDE_CONFIG_DIR: defaultHome },
            platform: "linux",
          },
          fetchApi,
        ),
      fetch: (input) => fetchClaudeUsage(claudeInputSchema.parse(input), fetchApi),
    });
    const usage = (reports: Awaited<ReturnType<typeof registry.listReports>>) =>
      Object.fromEntries(
        reports.map((entry) => [entry.account.label, entry.report.windows?.[0]?.usedPct]),
      );

    expect(usage(await registry.listReports({ agentId: "default" }))).toEqual({
      "old@example.com": 100,
    });
    await login(defaultHome, "rotated");
    expect(
      usage(await registry.listReports({ reportIds: ["claude:old.org"], forceRefresh: true })),
    ).toEqual({ "old@example.com": 100 });
    expect(usageTokens).toContain("rotated");
    await login(defaultHome, "new");
    usageTokens.length = 0;
    const [stale] = await registry.listReports({
      reportIds: ["claude:old.org"],
      forceRefresh: true,
    });
    expect.soft(stale?.report).toEqual({
      status: "error",
      error: "This Claude login now belongs to a different account. Refresh the usage list.",
    });
    expect.soft(stale?.lastSuccessful?.report.windows[0]?.usedPct).toBe(100);
    expect.soft(usageTokens).toEqual([]);

    const host = await registry.listReports({ forceRefresh: true });
    expect.soft(usage(host)).toEqual({ "new@example.com": 17 });
    expect
      .soft(usage(await registry.listReports({ agentId: "default" })))
      .toEqual({ "new@example.com": 17 });

    await login(otherHome, "old");
    sessions.set("other", {
      sessionKey: "second",
      provider: "claude",
      env: { HOME: root, CLAUDE_CONFIG_DIR: otherHome },
    });
    await registry.listReports({ agentId: "other" });
    expect(usage(await registry.listReports({ forceRefresh: true }))).toEqual({
      "new@example.com": 17,
      "old@example.com": 100,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
  providers?: readonly string[];
  discover?: () => Promise<
    Array<{ key: string; label?: string; harness?: string; provider?: string; input: unknown }>
  >;
  fetch?: (value: unknown) => Promise<unknown>;
}) {
  return {
    id: input.id,
    label: input.id,
    ...(input.providers ? { providers: input.providers } : {}),
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
  expect(one[0]).toEqual(two[0]);
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

test("session discovery rechecks logins, reuses cached usage, and includes live agent reports globally", async () => {
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
  expect(discoveries).toEqual(["/one", "/one", "/two"]);
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

test("uses provider activity as a defaultEnabled hint without blocking discovery", async () => {
  const activeProviders = new Set(["claude"]);
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: () => false,
    usageSession: () => null,
    isProviderActive: async (provider) => activeProviders.has(provider),
  });
  registry.register(
    source({
      id: "claude",
      providers: ["claude", "pi"],
      discover: async () => [
        { key: "cli", provider: "claude", input: "cli" },
        { key: "pi-only", provider: "pi", input: "pi" },
      ],
    }),
  );
  registry.register(
    source({
      id: "copilot",
      providers: ["copilot"],
      discover: async () => [{ key: "default", input: {} }],
    }),
  );
  registry.register(
    source({
      id: "openrouter",
      discover: async () => [{ key: "default", input: {} }],
    }),
  );

  const byId = (reports: Awaited<ReturnType<typeof registry.listReports>>) =>
    Object.fromEntries(reports.map((entry) => [entry.id, entry.defaultEnabled]));

  expect(byId(await registry.listReports())).toEqual({
    "claude:cli": undefined,
    "claude:pi-only": false,
    "copilot:default": false,
    "openrouter:default": undefined,
  });

  // Enabling a provider updates defaultEnabled on the next read without waiting for fetch cache expiry.
  activeProviders.add("copilot");
  expect(byId(await registry.listReports())).toEqual({
    "claude:cli": undefined,
    "claude:pi-only": false,
    "copilot:default": undefined,
    "openrouter:default": undefined,
  });
});

test("streams unrelated usage reports without waiting on a slow provider check and forwards forceRefresh", async () => {
  let resolveSlowCheck: ((active: boolean) => void) | undefined;
  const forceRefreshSeen: Array<{ provider: string; forceRefresh?: boolean }> = [];
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: () => false,
    usageSession: () => null,
    isProviderActive: (provider, options) => {
      forceRefreshSeen.push({ provider, forceRefresh: options?.forceRefresh });
      if (provider === "slow") {
        return new Promise<boolean>((resolve) => {
          resolveSlowCheck = resolve;
        });
      }
      return Promise.resolve(true);
    },
  });
  registry.register(
    source({
      id: "slow-source",
      providers: ["slow"],
      discover: async () => [{ key: "default", input: {} }],
    }),
  );
  registry.register(
    source({
      id: "fast-source",
      providers: ["fast"],
      discover: async () => [{ key: "default", input: {} }],
    }),
  );
  registry.register(
    source({
      id: "unhinted",
      discover: async () => [{ key: "default", input: {} }],
    }),
  );

  const streamed: string[] = [];
  let fastStreamed!: () => void;
  const bothFastStreamed = new Promise<void>((resolve) => {
    fastStreamed = resolve;
  });
  const pending = registry.listReports({
    forceRefresh: true,
    onReport: (report) => {
      streamed.push(report.id);
      if (streamed.includes("fast-source:default") && streamed.includes("unhinted:default")) {
        fastStreamed();
      }
    },
  });

  await bothFastStreamed;
  expect(streamed).not.toContain("slow-source:default");
  expect(forceRefreshSeen).toContainEqual({ provider: "slow", forceRefresh: true });
  expect(forceRefreshSeen).toContainEqual({ provider: "fast", forceRefresh: true });

  resolveSlowCheck?.(false);
  const reports = await pending;
  expect(reports.find((entry) => entry.id === "slow-source:default")?.defaultEnabled).toBe(false);
  expect(
    reports.find((entry) => entry.id === "fast-source:default")?.defaultEnabled,
  ).toBeUndefined();
});

test("Cursor multi-candidate discovery recovers from a 401 via fetchWithFallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-fallback-"));
  const { createRequire } = await import("node:module");
  const testRequire = createRequire(import.meta.url);
  try {
    const appData = join(root, "AppData", "Roaming");
    const dbDir = join(appData, "Cursor", "User", "globalStorage");
    await mkdir(dbDir, { recursive: true });
    const staleToken = `e30.${Buffer.from(JSON.stringify({ sub: "user-same", nonce: "stale" })).toString("base64url")}.sig`;
    const freshToken = `e30.${Buffer.from(JSON.stringify({ sub: "user-same", nonce: "fresh" })).toString("base64url")}.sig`;

    const { DatabaseSync } = testRequire("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...params: unknown[]): void };
        close(): void;
      };
    };
    const db = new DatabaseSync(join(dbDir, "state.vscdb"));
    db.exec(
      "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    );
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "cursorAuth/accessToken",
      staleToken,
    );
    db.close();

    await writeFile(
      join(appData, "Cursor", "auth.json"),
      JSON.stringify({ accessToken: freshToken }),
    );

    const seenAuth: string[] = [];
    const fetchApi: typeof fetch = async (_url, init) => {
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      seenAuth.push(auth);
      if (auth === `Bearer ${staleToken}`) {
        return new Response(null, { status: 401 });
      }
      if (auth === `Bearer ${freshToken}`) {
        return Response.json({
          planUsage: {
            totalPercentUsed: 31.18,
            autoPercentUsed: 18.5,
            apiPercentUsed: 44.2,
          },
          billingCycleStart: "2026-11-01T00:00:00.000Z",
          billingCycleEnd: "2026-12-01T00:00:00.000Z",
        });
      }
      throw new Error("Unexpected token");
    };

    const discoveredStores: string[] = [];
    const registry = new UsageSourceRegistry();
    registry.register({
      id: "cursor",
      label: "Cursor",
      discover: async (scope) => {
        if (scope.kind !== "global") return [];
        const accounts = await discoverCursor({
          platform: "win32",
          home: root,
          env: { APPDATA: appData },
          readKeychain: async () => null,
        });
        discoveredStores.push(
          ...accounts.map((account) => cursorInputSchema.parse(account.input).store),
        );
        return accounts;
      },
      fetch: (input) => fetchCursorUsage(cursorInputSchema.parse(input), fetchApi),
    });

    const reports = await registry.listReports();
    expect(discoveredStores).toEqual(["sqlite", "file"]);
    expect(reports).toHaveLength(1);
    expect(new Set(seenAuth)).toEqual(new Set([`Bearer ${staleToken}`, `Bearer ${freshToken}`]));
    expect(reports[0]?.report).toMatchObject({
      status: "available",
      windows: [
        expect.objectContaining({ id: "plan_usage", usedPct: 31.18 }),
        expect.objectContaining({ id: "cursor_usage", usedPct: 18.5 }),
        expect.objectContaining({ id: "third_party_usage", usedPct: 44.2 }),
      ],
    });
    expect(reports[0]?.loginErrors).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cursor macOS discovery recovers from a stale desktop 401 via Keychain fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-mac-fallback-"));
  const { createRequire } = await import("node:module");
  const testRequire = createRequire(import.meta.url);
  try {
    const dbDir = join(root, "Library", "Application Support", "Cursor", "User", "globalStorage");
    await mkdir(dbDir, { recursive: true });
    const staleToken = `e30.${Buffer.from(JSON.stringify({ sub: "user-mac", nonce: "stale" })).toString("base64url")}.sig`;
    const keychainToken = `e30.${Buffer.from(JSON.stringify({ sub: "user-mac", nonce: "keychain" })).toString("base64url")}.sig`;

    const { DatabaseSync } = testRequire("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...params: unknown[]): void };
        close(): void;
      };
    };
    const db = new DatabaseSync(join(dbDir, "state.vscdb"));
    db.exec(
      "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    );
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "cursorAuth/accessToken",
      staleToken,
    );
    db.close();

    const readKeychain = async () => keychainToken;
    const seenAuth: string[] = [];
    const fetchApi: typeof fetch = async (_url, init) => {
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      seenAuth.push(auth);
      if (auth === `Bearer ${staleToken}`) return new Response(null, { status: 401 });
      if (auth === `Bearer ${keychainToken}`) {
        return Response.json({
          planUsage: { totalPercentUsed: 19.7, autoPercentUsed: 18.9, apiPercentUsed: 42.2 },
        });
      }
      throw new Error("Unexpected token");
    };

    const discoveredStores: string[] = [];
    const registry = new UsageSourceRegistry();
    registry.register({
      id: "cursor",
      label: "Cursor",
      discover: async (scope) => {
        if (scope.kind !== "global") return [];
        const accounts = await discoverCursor({
          platform: "darwin",
          home: root,
          env: {},
          readKeychain,
        });
        discoveredStores.push(
          ...accounts.map((account) => cursorInputSchema.parse(account.input).store),
        );
        return accounts;
      },
      fetch: (input) =>
        fetchCursorUsage(cursorInputSchema.parse(input), fetchApi, {
          platform: "darwin",
          readKeychain,
        }),
    });

    const reports = await registry.listReports();
    expect(discoveredStores).toEqual(["sqlite", "keychain"]);
    expect(reports).toHaveLength(1);
    expect(new Set(seenAuth)).toEqual(new Set([`Bearer ${staleToken}`, `Bearer ${keychainToken}`]));
    expect(reports[0]?.report).toMatchObject({
      status: "available",
      windows: [
        expect.objectContaining({ id: "plan_usage", usedPct: 19.7 }),
        expect.objectContaining({ id: "cursor_usage", usedPct: 18.9 }),
        expect.objectContaining({ id: "third_party_usage", usedPct: 42.2 }),
      ],
    });
    expect(reports[0]?.loginErrors).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#3589: host listings discover configured providers with distinct config dirs after global logins", async () => {
  let providers = [
    { provider: "claude", label: "Claude (work)", env: { CLAUDE_CONFIG_DIR: "/work" } },
    {
      provider: "claude",
      label: "Claude (secure)",
      env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/secure" },
    },
    { provider: "claude", label: "Claude (copy)", env: { CLAUDE_CONFIG_DIR: "/default-copy" } },
    { provider: "codex", label: "Codex (work)", env: { CODEX_HOME: "/codex-work" } },
  ];
  const calls: unknown[] = [];
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: () => false,
    usageSession: () => null,
    providerEnvironments: () => providers,
  });
  registry.register({
    id: "claude",
    label: "Claude",
    providers: ["claude", "pi", "omp"],
    discover: async (scope) => {
      if (scope.kind === "global") return [{ key: "default", input: "/default" }];
      const dir = scope.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? scope.env.CLAUDE_CONFIG_DIR;
      if (dir === "/work") return [{ key: "work", input: dir }];
      if (dir === "/secure") return [{ key: "secure", input: dir }];
      return [{ key: "default", input: dir }];
    },
    fetch: async (input) => {
      calls.push(input);
      return input === "/default"
        ? { status: "unavailable", problem: { kind: "rejected", status: 401 } }
        : { status: "available", windows: [] };
    },
  });
  registry.register({
    id: "codex",
    label: "Codex",
    providers: ["codex", "opencode", "pi", "omp"],
    discover: async (scope) => {
      if (scope.kind === "global") return [];
      return [{ key: "work", input: scope.env.CODEX_HOME }];
    },
    fetch: async (input) => {
      calls.push(input);
      return { status: "available", windows: [] };
    },
  });
  const reports = await registry.listReports();
  expect(reports.map((entry) => [entry.id, entry.report.status])).toEqual([
    ["claude:default", "available"],
    ["claude:work", "available"],
    ["claude:secure", "available"],
    ["codex:work", "available"],
  ]);
  expect(calls).toEqual(["/default", "/default-copy", "/work", "/secure", "/codex-work"]);
  providers = [];
  expect((await registry.listReports()).map((entry) => entry.id)).toEqual(["claude:default"]);
});

test("#3589: configured provider discovery dispatches ONLY to sources whose providers list matches", async () => {
  const seenBySource = new Map<
    string,
    Array<{ kind: string; provider?: string; env?: Record<string, string> }>
  >();
  const record = (
    id: string,
    scope: { kind: string; provider?: string; env?: Record<string, string> },
  ) => {
    const entries = seenBySource.get(id) ?? [];
    entries.push(scope);
    seenBySource.set(id, entries);
  };
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: () => false,
    usageSession: () => null,
    providerEnvironments: () => [
      { provider: "claude", label: "Claude (work)", env: { CLAUDE_CONFIG_DIR: "/claude-work" } },
      { provider: "codex", label: "Codex (work)", env: { CODEX_HOME: "/codex-work" } },
    ],
  });
  registry.register({
    id: "claude",
    label: "Claude",
    providers: ["claude", "pi", "omp"],
    discover: async (scope) => {
      record("claude", scope);
      return [];
    },
    fetch: async () => ({ status: "available", windows: [] }),
  });
  registry.register({
    id: "codex",
    label: "Codex",
    providers: ["codex", "opencode"],
    discover: async (scope) => {
      record("codex", scope);
      return [];
    },
    fetch: async () => ({ status: "available", windows: [] }),
  });
  registry.register({
    id: "third-party-unscoped",
    label: "Third-Party Unscoped",
    discover: async (scope) => {
      record("third-party-unscoped", scope);
      return [];
    },
    fetch: async () => ({ status: "available", windows: [] }),
  });
  registry.register({
    id: "third-party-other",
    label: "Third-Party Other",
    providers: ["other"],
    discover: async (scope) => {
      record("third-party-other", scope);
      return [];
    },
    fetch: async () => ({ status: "available", windows: [] }),
  });

  await registry.listReports();

  expect(seenBySource.get("claude")).toEqual([
    { kind: "global" },
    { kind: "session", provider: "claude", env: { CLAUDE_CONFIG_DIR: "/claude-work" } },
  ]);
  expect(seenBySource.get("codex")).toEqual([
    { kind: "global" },
    { kind: "session", provider: "codex", env: { CODEX_HOME: "/codex-work" } },
  ]);
  expect(seenBySource.get("third-party-unscoped")).toEqual([{ kind: "global" }]);
  expect(seenBySource.get("third-party-other")).toEqual([{ kind: "global" }]);
});

test("#3589: configured provider discovery strips secret and arbitrary env vars and skips secret-only providers", async () => {
  const receivedEnvs: Array<Record<string, string>> = [];
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: () => false,
    usageSession: () => null,
    providerEnvironments: () => [
      {
        provider: "claude",
        label: "Claude (mixed)",
        env: {
          HOME: "/home/alice",
          CLAUDE_CONFIG_DIR: "/claude-work",
          CLAUDE_SECURESTORAGE_CONFIG_DIR: "/claude-secure",
          XDG_CONFIG_HOME: "/home/alice/.config",
          XDG_DATA_HOME: "/home/alice/.local/share",
          OPENCODE_CONFIG_DIR: "/opencode-cfg",
          OPENCODE_DB: "/opencode-data/opencode.db",
          ANTHROPIC_API_KEY: "sk-ant-secret",
          ANTHROPIC_AUTH_TOKEN: "auth-token-secret",
          CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-secret",
          OPENAI_API_KEY: "sk-openai-secret",
          MY_SECRET: "arbitrary-secret",
        },
      },
      {
        provider: "claude",
        label: "Claude (secret-only)",
        env: {
          HOME: "/home/alice",
          ANTHROPIC_API_KEY: "sk-ant-only",
          MY_SECRET: "only-secret",
        },
        configuredEnvKeys: ["ANTHROPIC_API_KEY", "MY_SECRET"],
      },
      {
        provider: "claude",
        label: "Claude (proxy)",
        env: {
          HOME: "/home/alice",
          CLAUDE_CONFIG_DIR: "/claude-proxy",
          ANTHROPIC_BASE_URL: "https://llm-proxy.example",
        },
        configuredEnvKeys: ["CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL"],
      },
      {
        provider: "claude",
        label: "Claude (bedrock)",
        env: {
          HOME: "/home/alice",
          CLAUDE_CONFIG_DIR: "/claude-bedrock",
          CLAUDE_CODE_USE_BEDROCK: "1",
        },
        configuredEnvKeys: ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_USE_BEDROCK"],
      },
    ],
  });
  registry.register({
    id: "claude",
    label: "Claude",
    providers: ["claude"],
    discover: async (scope) => {
      if (scope.kind === "session") receivedEnvs.push(scope.env);
      return [];
    },
    fetch: async () => ({ status: "available", windows: [] }),
  });

  await registry.listReports();

  expect(receivedEnvs).toEqual([
    {
      HOME: "/home/alice",
      CLAUDE_CONFIG_DIR: "/claude-work",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "/claude-secure",
      XDG_CONFIG_HOME: "/home/alice/.config",
      XDG_DATA_HOME: "/home/alice/.local/share",
      OPENCODE_CONFIG_DIR: "/opencode-cfg",
      OPENCODE_DB: "/opencode-data/opencode.db",
    },
  ]);
});

test("#3589: a failed provider login is named after its provider; one the host already has keeps the host's name", async () => {
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: () => false,
    usageSession: () => null,
    providerEnvironments: () => [
      { provider: "claude", label: "Claude (home)", env: { CLAUDE_CONFIG_DIR: "/default" } },
      { provider: "claude", label: "Claude (a)", env: { CLAUDE_CONFIG_DIR: "/a" } },
      { provider: "claude", label: "Claude (b)", env: { CLAUDE_CONFIG_DIR: "/b" } },
      { provider: "claude", label: "Claude (b again)", env: { CLAUDE_CONFIG_DIR: "/b" } },
    ],
  });
  registry.register({
    id: "claude",
    label: "Claude",
    providers: ["claude"],
    discover: async (scope) => {
      const dir = scope.kind === "global" ? "/default" : scope.env.CLAUDE_CONFIG_DIR;
      return [{ key: `dir${dir?.replace("/", "-")}`, harness: "Claude", input: dir }];
    },
    fetch: async () => ({
      status: "unavailable",
      problem: { kind: "expired", expiresAt: "1970-01-01T00:00:01.000Z", refreshedBy: "claude" },
    }),
  });
  const reports = await registry.listReports();
  expect(
    reports.map((entry) => [entry.id, entry.loginErrors?.map((login) => login.harness)]),
  ).toEqual([
    ["claude:dir-default", ["Claude"]],
    ["claude:dir-a", ["Claude (a)"]],
    ["claude:dir-b", ["Claude (b)"]],
  ]);
});

test("#3589: a provider's failed discovery keeps only that provider's last logins", async () => {
  let providers = [
    { provider: "claude", label: "Claude (work)", env: { CLAUDE_CONFIG_DIR: "/work" } },
  ];
  const failing = new Set<string>();
  const registry = new UsageSourceRegistry(
    Date.now,
    300_000,
    { warn: () => {} },
    {
      hasAgent: () => false,
      usageSession: () => null,
      providerEnvironments: () => providers,
    },
  );
  registry.register({
    id: "claude",
    label: "Claude",
    providers: ["claude"],
    discover: async (scope) => {
      const dir = scope.kind === "global" ? "/default" : scope.env.CLAUDE_CONFIG_DIR;
      if (dir && failing.has(dir)) throw new Error("Login store temporarily unavailable");
      return [{ key: dir!.slice(1), input: dir }];
    },
    fetch: async () => ({ status: "available", windows: [] }),
  });
  const listIds = async () => (await registry.listReports()).map((entry) => entry.id);
  expect(await listIds()).toEqual(["claude:default", "claude:work"]);
  failing.add("/work");
  expect(await listIds()).toEqual(["claude:default", "claude:work"]);
  // Renaming a provider keeps its launch environment.
  providers = [{ provider: "claude", label: "Claude (Work)", env: { CLAUDE_CONFIG_DIR: "/work" } }];
  expect(await listIds()).toEqual(["claude:default", "claude:work"]);
  // A changed launch environment has no previous result to keep.
  providers = [
    { provider: "claude", label: "Claude (work)", env: { CLAUDE_CONFIG_DIR: "/other" } },
  ];
  failing.add("/other");
  expect(await listIds()).toEqual(["claude:default"]);
  failing.clear();
  providers = [{ provider: "claude", label: "Claude (work)", env: { CLAUDE_CONFIG_DIR: "/work" } }];
  expect(await listIds()).toEqual(["claude:default", "claude:work"]);
  // The host's own failed discovery keeps the host's logins, not a disabled provider's.
  providers = [];
  failing.add("/default");
  expect(await listIds()).toEqual(["claude:default"]);
});

test("#3589: renaming a provider preserves cached usage and recovery history while updating error labels", async () => {
  let label = "Before";
  let available = true;
  let polls = 0;
  const registry = new UsageSourceRegistry(Date.now, 300_000, undefined, {
    hasAgent: () => false,
    usageSession: () => null,
    providerEnvironments: () => [
      { provider: "claude", label, env: { CLAUDE_CONFIG_DIR: "/work" } },
    ],
  });
  registry.register({
    id: "claude",
    label: "Claude",
    providers: ["claude"],
    discover: async (scope) =>
      scope.kind === "global" ? [] : [{ key: "work", input: { path: "/work" } }],
    fetch: async () => {
      polls++;
      return available
        ? { status: "available", windows: [{ id: "weekly", label: "Weekly", usedPct: 42 }] }
        : { status: "error", error: "offline" };
    },
  });
  const [success] = await registry.listReports();
  available = false;
  label = "After";
  const [cached] = await registry.listReports();
  expect(cached?.report).toEqual(success?.report);
  expect(polls).toBe(1);
  const [failed] = await registry.listReports({ forceRefresh: true });
  expect(failed?.lastSuccessful?.report).toEqual(success?.report);
  expect(failed?.loginErrors?.map((login) => login.harness)).toEqual(["After"]);
  label = "Renamed again";
  const [relabeled] = await registry.listReports();
  expect(polls).toBe(2);
  expect(relabeled?.lastSuccessful).toEqual(failed?.lastSuccessful);
  expect(relabeled?.loginErrors?.map((login) => login.harness)).toEqual(["Renamed again"]);
});

test("unregistering a source drops the accounts each host scope kept for it", async () => {
  let fails = false;
  const registry = new UsageSourceRegistry(Date.now, 300_000, { warn: () => {} });
  const claude = source({
    id: "claude",
    providers: ["claude"],
    discover: async () => {
      if (fails) throw new Error("Login store temporarily unavailable");
      return [{ key: "default", input: {} }];
    },
  });
  registry.register(claude);
  expect((await registry.listReports()).map((entry) => entry.id)).toEqual(["claude:default"]);
  registry.unregister("claude");
  registry.register(claude);
  fails = true;
  expect(await registry.listReports()).toEqual([]);
});

test("a failed fetch is retried after 30 seconds, backing off to the five-minute cache", async () => {
  let now = 0;
  let fetches = 0;
  let result: unknown = { status: "error", error: "Claude usage API returned 500" };
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({
      id: "quota",
      discover: async () => [{ key: "account", input: {} }],
      fetch: async () => {
        fetches++;
        return result;
      },
    }),
  );
  const fetchesAt = async (at: number) => {
    now = at;
    await registry.listReports();
    return fetches;
  };
  expect(await fetchesAt(0)).toBe(1);
  expect(await fetchesAt(29_999)).toBe(1);
  expect(await fetchesAt(30_000)).toBe(2);
  // The second failure in a row waits twice as long.
  expect(await fetchesAt(89_999)).toBe(2);
  expect(await fetchesAt(90_000)).toBe(3);
  result = { status: "available", windows: [] };
  expect(await fetchesAt(210_000)).toBe(4);
  // A success is kept for the full five minutes again.
  expect(await fetchesAt(509_999)).toBe(4);
  expect(await fetchesAt(510_000)).toBe(5);
});

function observedUsageRegistry(now: () => number) {
  const sessions = new Map([
    ["working", { provider: "claude", env: { HOME: "/work" }, sessionKey: "launch-1" }],
    ["elsewhere", { provider: "claude", env: { HOME: "/other" }, sessionKey: "launch-2" }],
    ["codex-agent", { provider: "codex", env: { HOME: "/work" }, sessionKey: "launch-3" }],
    ["no-account", { provider: "claude", env: { HOME: "/missing" }, sessionKey: "launch-4" }],
  ]);
  const fetched: string[] = [];
  const registry = new UsageSourceRegistry(now, 300_000, undefined, {
    hasAgent: (id) => sessions.has(id),
    usageSession: (id) => sessions.get(id) ?? null,
  });
  registry.register({
    id: "claude",
    label: "Claude",
    discover: async (scope) => {
      if (scope.kind === "session" && scope.provider !== "claude") return [];
      if (scope.kind === "session" && scope.env.HOME === "/missing") return [];
      const key = scope.kind === "session" && scope.env.HOME === "/other" ? "other" : "work";
      return [{ key, input: key }];
    },
    fetch: async (input) => {
      fetched.push(String(input));
      return {
        status: "available",
        observedAt: "2026-11-27T00:00:00.000Z",
        windows: [
          { id: "five_hour", label: "Session", usedPct: 10, remainingPct: 90, tone: "ok" },
          { id: "weekly", label: "Weekly", usedPct: 50, remainingPct: 50, tone: "ok" },
          { id: "weekly_model_fable", label: "Weekly · Fable", usedPct: 30, remainingPct: 70 },
        ],
      };
    },
  });
  registry.register({
    id: "codex",
    label: "Codex",
    discover: async (scope) => {
      if (scope.kind === "session" && scope.provider !== "codex") return [];
      return [{ key: "codex-acct", input: "codex-acct" }];
    },
    fetch: async (input) => {
      fetched.push(String(input));
      return {
        status: "available",
        planLabel: "plus",
        observedAt: "2026-11-27T00:00:00.000Z",
        windows: [
          { id: "five_hour", label: "5-hour", usedPct: 5, remainingPct: 95, tone: "ok" },
          { id: "weekly", label: "Weekly", usedPct: 20, remainingPct: 80, tone: "ok" },
        ],
        balances: [{ id: "credits", label: "Credits", remaining: 10, unit: "credits", tone: "ok" }],
      };
    },
  });
  return { registry, fetched };
}

test("usage an agent observes moves only its account's cached report, and keeps windows the observation lacks", async () => {
  let now = 1_000;
  const { registry, fetched } = observedUsageRegistry(() => now);
  const announced: Array<{ id: string; windows: unknown }> = [];
  registry.subscribe((entry) =>
    announced.push({
      id: entry.id,
      windows: entry.report.status === "available" ? entry.report.windows : null,
    }),
  );
  await registry.listReports();
  await registry.listReports({ agentId: "elsewhere" });
  expect(fetched).toEqual(["work", "codex-acct", "other"]);

  now = 61_000;
  await registry.observeUsage("working", {
    sourceId: "claude",
    windows: [
      {
        id: "five_hour",
        label: "Session",
        usedPct: 73,
        remainingPct: 27,
        resetsAt: "2026-11-27T20:40:00.000Z",
        tone: "warning",
      },
      {
        id: "weekly",
        label: "Weekly",
        usedPct: 91,
        remainingPct: 9,
        resetsAt: null,
        tone: "danger",
      },
    ],
  });
  // Another source's observation and an unknown agent change nothing.
  await registry.observeUsage("working", {
    sourceId: "codex",
    windows: [{ id: "weekly", label: "Weekly", usedPct: 1, resetsAt: null }],
  });
  await registry.observeUsage("gone", {
    sourceId: "claude",
    windows: [{ id: "weekly", label: "Weekly", usedPct: 1, resetsAt: null }],
  });

  const merged = [
    {
      id: "five_hour",
      label: "Session",
      usedPct: 73,
      remainingPct: 27,
      resetsAt: "2026-11-27T20:40:00.000Z",
      tone: "warning",
    },
    { id: "weekly", label: "Weekly", usedPct: 91, remainingPct: 9, resetsAt: null, tone: "danger" },
    { id: "weekly_model_fable", label: "Weekly · Fable", usedPct: 30, remainingPct: 70 },
  ];
  expect(announced).toEqual([{ id: "claude:work", windows: merged }]);
  const reports = await registry.listReports();
  expect(fetched).toEqual(["work", "codex-acct", "other"]);
  const work = reports.find((entry) => entry.id === "claude:work");
  expect(work).toMatchObject({
    fetchedAt: new Date(now).toISOString(),
    successfulAt: new Date(now).toISOString(),
    report: { status: "available", windows: merged },
  });
  // The observation is the newest sample, so the fetch's observation time no longer applies.
  expect(work?.report).not.toHaveProperty("observedAt");
  expect(reports.find((entry) => entry.id === "claude:other")?.report).toMatchObject({
    windows: [{ usedPct: 10 }, { usedPct: 50 }, { usedPct: 30 }],
  });

  // The cache keeps its fetch time, so the per-model window still refreshes on schedule.
  now = 301_000;
  await registry.listReports();
  expect(fetched.filter((input) => input === "work")).toHaveLength(2);
});

test("Codex observations update windows, balances, and planLabel on the discovered account's cached report", async () => {
  let now = 1_000;
  const { registry } = observedUsageRegistry(() => now);
  const announced: UsageReportEntry[] = [];
  registry.subscribe((entry) => announced.push(entry));
  await registry.listReports();

  now = 31_000;
  await registry.observeUsage("codex-agent", {
    sourceId: "codex",
    planLabel: "pro",
    windows: [
      {
        id: "five_hour",
        label: "5-hour",
        usedPct: 31,
        remainingPct: 69,
        resetsAt: "2026-11-27T20:40:00.000Z",
        tone: "ok",
      },
      {
        id: "weekly",
        label: "Weekly",
        usedPct: 64,
        remainingPct: 36,
        resetsAt: "2026-11-29T02:00:00.000Z",
        tone: "ok",
      },
    ],
    balances: [{ id: "credits", label: "Credits", remaining: 19.5, unit: "credits", tone: "ok" }],
  });

  expect(announced).toHaveLength(1);
  expect(announced[0]).toMatchObject({
    id: "codex:codex-acct",
    fetchedAt: new Date(now).toISOString(),
    successfulAt: new Date(now).toISOString(),
    report: {
      status: "available",
      planLabel: "pro",
      windows: [
        {
          id: "five_hour",
          label: "5-hour",
          usedPct: 31,
          remainingPct: 69,
          resetsAt: "2026-11-27T20:40:00.000Z",
          tone: "ok",
        },
        {
          id: "weekly",
          label: "Weekly",
          usedPct: 64,
          remainingPct: 36,
          resetsAt: "2026-11-29T02:00:00.000Z",
          tone: "ok",
        },
      ],
      balances: [{ id: "credits", label: "Credits", remaining: 19.5, unit: "credits", tone: "ok" }],
    },
  });
  expect(announced[0]?.report).not.toHaveProperty("observedAt");
});

test("ignores observations when the agent has no discovered disk account for that source", async () => {
  let now = 1_000;
  const { registry, fetched } = observedUsageRegistry(() => now);
  const announced: string[] = [];
  registry.subscribe((entry) => announced.push(entry.id));

  await registry.observeUsage("no-account", {
    sourceId: "claude",
    windows: [{ id: "five_hour", label: "Session", usedPct: 45, resetsAt: null }],
  });
  await new Promise((resolve) => setImmediate(resolve));

  expect(fetched).toEqual([]);
  expect(announced).toEqual([]);
});

test("an observation without usage refetches its account at most once a minute and announces it", async () => {
  let now = 0;
  const { registry, fetched } = observedUsageRegistry(() => now);
  const announced: string[] = [];
  registry.subscribe((entry) => announced.push(`${entry.id}@${entry.fetchedAt}`));
  await registry.listReports();
  const observeNothing = async (at: number) => {
    now = at;
    await registry.observeUsage("working", { sourceId: "claude", windows: [] });
    await new Promise((resolve) => setImmediate(resolve));
  };
  await observeNothing(10_000);
  await observeNothing(69_000);
  await observeNothing(70_000);
  expect(fetched.filter((input) => input === "work")).toEqual(["work", "work", "work"]);
  expect(announced).toEqual([
    `claude:work@${new Date(10_000).toISOString()}`,
    `claude:work@${new Date(70_000).toISOString()}`,
  ]);
});

test("a throttled refetch schedules one trailing refetch at the end of the minute window", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-11-28T00:00:00.000Z"));
    const { registry, fetched } = observedUsageRegistry(() => Date.now());
    const announced: string[] = [];
    const unsubscribe = registry.subscribe((entry) => announced.push(entry.fetchedAt));
    await registry.listReports();

    vi.advanceTimersByTime(10_000);
    await registry.observeUsage("working", { sourceId: "claude", windows: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetched.filter((input) => input === "work")).toHaveLength(2);

    // Two turns finish inside the 60s throttle window: neither fetches immediately, and they
    // coalesce into a single trailing refetch when the 60s window expires.
    vi.advanceTimersByTime(20_000);
    await registry.observeUsage("working", { sourceId: "claude", windows: [] });
    vi.advanceTimersByTime(15_000);
    await registry.observeUsage("working", { sourceId: "claude", windows: [] });
    expect(fetched.filter((input) => input === "work")).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(24_999);
    expect(fetched.filter((input) => input === "work")).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetched.filter((input) => input === "work")).toHaveLength(3);
    expect(announced).toHaveLength(2);

    // If every listener unsubscribes before a trailing timer fires, it skips the fetch.
    vi.advanceTimersByTime(10_000);
    await registry.observeUsage("working", { sourceId: "claude", windows: [] });
    unsubscribe();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetched.filter((input) => input === "work")).toHaveLength(3);
  } finally {
    vi.useRealTimers();
  }
});

test("with no app listening, an observation neither fetches nor discovers reports", async () => {
  let now = 0;
  const { registry, fetched } = observedUsageRegistry(() => now);
  await registry.listReports();
  now = 10_000;
  await registry.observeUsage("working", { sourceId: "claude", windows: [] });
  await new Promise((resolve) => setImmediate(resolve));
  expect(fetched.filter((input) => input === "work")).toEqual(["work"]);

  // Once an app listens, the same observation refetches the account.
  const stop = registry.subscribe(() => {});
  await registry.observeUsage("working", { sourceId: "claude", windows: [] });
  await new Promise((resolve) => setImmediate(resolve));
  expect(fetched.filter((input) => input === "work")).toEqual(["work", "work"]);
  stop();
});

test("with no app listening, usage from an agent no client listed fetches nothing", async () => {
  const { registry, fetched } = observedUsageRegistry(() => 0);
  await registry.observeUsage("working", {
    sourceId: "claude",
    windows: [{ id: "weekly", label: "Weekly", usedPct: 91, resetsAt: null }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(fetched).toEqual([]);
});

test("usage observed before any report was fetched fetches the account once", async () => {
  let now = 0;
  const { registry, fetched } = observedUsageRegistry(() => now);
  const announced: string[] = [];
  registry.subscribe((entry) => announced.push(entry.id));
  await registry.observeUsage("working", {
    sourceId: "claude",
    windows: [{ id: "weekly", label: "Weekly", usedPct: 91, resetsAt: null }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(fetched).toEqual(["work"]);
  expect(announced).toEqual(["claude:work"]);
});

test("unregister clears failure backoff and observed refetch throttle for that source", async () => {
  let now = 0;
  let fetches = 0;
  const registry = new UsageSourceRegistry(() => now, 300_000, undefined, {
    hasAgent: (id) => id === "working",
    usageSession: (id) =>
      id === "working" ? { provider: "claude", env: {}, sessionKey: "s1" } : null,
  });
  const makeSource = () =>
    source({
      id: "claude",
      discover: async () => [{ key: "acct", input: {} }],
      fetch: async () => {
        fetches++;
        return { status: "error", error: "500" };
      },
    });
  registry.register(makeSource());
  registry.subscribe(() => {});

  await registry.listReports();
  await registry.observeUsage("working", { sourceId: "claude", windows: [] });
  await new Promise((resolve) => setImmediate(resolve));
  expect(fetches).toBe(2);

  // Unregister and re-register: backoff and refetch throttle should start clean.
  registry.unregister("claude");
  registry.register(makeSource());
  now = 1_000;
  await registry.observeUsage("working", { sourceId: "claude", windows: [] });
  await new Promise((resolve) => setImmediate(resolve));
  expect(fetches).toBe(3);
});
