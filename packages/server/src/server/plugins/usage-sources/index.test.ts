import { expect, test } from "vitest";
import { UsageSourceRegistry } from "./index.js";

function source(input: {
  id: string;
  discover?: () => Promise<unknown[]>;
  identify?: (value: unknown) => Promise<{ key: string } | null>;
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

test("identifies accounts without fetching and preserves IDs across token rotation", async () => {
  const registry = new UsageSourceRegistry();
  let fetches = 0;
  let token = "old";
  registry.register(
    source({
      id: "codex",
      discover: async () => [{ account: "work", token }],
      fetch: async (input) => {
        fetches++;
        return {
          status: "available",
          windows: [{ id: "token", label: (input as { token: string }).token }],
        };
      },
    }),
  );
  expect(
    await registry.resolveReference({ source: "codex", input: { account: "work", token } }),
  ).toBe("codex:work");
  expect(fetches).toBe(0);
  token = "new";
  expect(
    await registry.resolveReference({ source: "codex", input: { account: "work", token } }),
  ).toBe("codex:work");
  expect(
    (await registry.listReports({ reportIds: ["codex:work"] }))[0]?.report.windows[0]?.label,
  ).toBe("new");
  expect(fetches).toBe(1);
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
  expect(
    await registry.resolveReference({ source: "source", input: { account: "none" } }),
  ).toBeNull();
});

test("legacy listing uses oldest fetchedAt", async () => {
  let now = 1000;
  const registry = new UsageSourceRegistry(() => now);
  registry.register(
    source({ id: "source", discover: async () => [{ account: "a" }, { account: "b" }] }),
  );
  await registry.listReports({ references: [{ source: "source", input: { account: "a" } }] });
  now = 2000;
  await registry.listReports({ reportIds: ["source:b"], forceRefresh: true });
  expect((await registry.listLegacyUsage()).fetchedAt).toBe(new Date(1000).toISOString());
});

test("two Codex homes and a token route resolve to their vendor account IDs", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { identify } = await import("../../../../../../plugins/codex-usage-source/server/usage.js");
  const personal = await mkdtemp(join(tmpdir(), "usage-personal-"));
  const work = await mkdtemp(join(tmpdir(), "usage-work-"));
  try {
    const token = (accountId: string, email: string) =>
      `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId }, email })).toString("base64url")}.signature`;
    await writeFile(
      join(personal, "auth.json"),
      JSON.stringify({
        tokens: {
          account_id: "personal-id",
          access_token: token("personal-id", "personal@example.test"),
        },
      }),
    );
    await writeFile(
      join(work, "auth.json"),
      JSON.stringify({
        tokens: { account_id: "work-id", access_token: token("work-id", "work@example.test") },
      }),
    );
    const registry = new UsageSourceRegistry();
    registry.register(
      source({
        id: "codex",
        discover: async () => [{ codexHome: personal }, { codexHome: work }],
        identify: async (input) => identify(input as Parameters<typeof identify>[0]),
      }),
    );

    expect(
      await registry.resolveReference({
        source: "codex",
        input: { accessToken: token("work-id", "work@example.test") },
      }),
    ).toBe("codex:work-id");
    expect((await registry.listReports()).map((entry) => [entry.id, entry.account.label])).toEqual([
      ["codex:personal-id", "personal@example.test"],
      ["codex:work-id", "work@example.test"],
    ]);
  } finally {
    await rm(personal, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
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
      fetch: async () => {
        fetches++;
        return response;
      },
    }),
  );
  await registry.resolveReference({ source: "coalesced", input: { account: "one" } });
  const first = registry.listReports({ reportIds: ["coalesced:one"] });
  const second = registry.listReports({ reportIds: ["coalesced:one"], forceRefresh: true });
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
  registry.register(source({ id: "source" }));
  await registry.resolveReference({ source: "source", input: { account: "old" } });
  await registry.listReports({ reportIds: ["source:old"] });
  now = 101;
  await registry.resolveReference({ source: "source", input: { account: "new" } });
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
  expect(await registry.resolveReference({ source: "source", input: { account: "error" } })).toBe(
    "source:error",
  );
  const discovered = await registry.listReports();
  expect(discovered.map((entry) => entry.id)).toEqual(["source:!error"]);
  const both = await registry.listReports({ reportIds: ["source:error", "source:!error"] });
  expect(both.map((entry) => entry.report.status)).toEqual(["available", "error"]);
});
