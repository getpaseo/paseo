import { expect, test } from "vitest";
import { discover, fetchUsage, inputSchema } from "./usage.js";

const scope = { kind: "global" } as const;
const env = {
  OPENROUTER_API_KEY: " api-key ",
  OPENROUTER_MANAGEMENT_KEY: " management-key ",
};

const spend = {
  usage: 32,
  usage_daily: 0.0123,
  usage_weekly: 1,
  usage_monthly: 8,
};

test("discovers only host credentials and returns credential-free inputs", async () => {
  expect(await discover(scope, env)).toEqual([
    { key: "key", label: "API key spend", input: { meter: "key" } },
    { key: "credits", label: "Account credits", input: { meter: "credits" } },
  ]);
  expect(await discover(scope, { OPENROUTER_API_KEY: " " })).toEqual([]);
  expect(await discover({ kind: "session", provider: "pi", env }, env)).toEqual([]);
  expect(inputSchema.safeParse({ meter: "key", token: "secret" }).success).toBe(false);
});

test("reports spend for the three UTC periods", async () => {
  const report = await fetchUsage(
    { meter: "key" },
    async (url, init) => {
      expect(url).toBe("https://openrouter.ai/api/v1/key");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer api-key");
      expect(init?.redirect).toBe("error");
      return Response.json({ data: spend });
    },
    env,
  );
  expect(report).toEqual({
    status: "available",
    windows: [],
    details: [
      { id: "spend_daily", label: "Spent today (UTC)", value: "$0.0123" },
      { id: "spend_weekly", label: "Spent this week (UTC)", value: "$1.00" },
      { id: "spend_monthly", label: "Spent this month (UTC)", value: "$8.00" },
    ],
  });
});

test("uses the management key exclusively for account credits", async () => {
  const report = await fetchUsage(
    { meter: "credits" },
    async (url, init) => {
      expect(url).toBe("https://openrouter.ai/api/v1/credits");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer management-key");
      return Response.json({ data: { total_credits: 15, total_usage: 4 } });
    },
    env,
  );
  expect(report).toEqual({
    status: "available",
    windows: [],
    balances: [{ id: "credits", label: "Credits", remaining: 11, unit: "usd", tone: "ok" }],
  });
});

test("reports rejected credentials without including the upstream body", async () => {
  const report = await fetchUsage(
    { meter: "credits" },
    async () => new Response("sensitive upstream error", { status: 403 }),
    env,
  );
  expect(report).toEqual({ status: "unavailable", problem: { kind: "rejected", status: 403 } });
});
