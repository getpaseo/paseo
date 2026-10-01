import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { fetchUsage, identify } from "./usage.js";

import { inputSchema } from "../shared/input.js";

let fixtureHome: string;
beforeEach(async () => {
  fixtureHome = await mkdtemp(join(tmpdir(), "usage-codex-default-"));
  process.env["CODEX_HOME"] = fixtureHome;
  await writeAuth("fixture-supplied");
});

async function writeAuth(accessToken: string, accountId?: string) {
  await writeFile(
    join(fixtureHome, "auth.json"),
    JSON.stringify({ tokens: { access_token: accessToken, account_id: accountId } }),
  );
}

const originalHome = process.env["CODEX_HOME"];
afterEach(async () => {
  await rm(fixtureHome, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env["CODEX_HOME"];
  else process.env["CODEX_HOME"] = originalHome;
});

function response(headers: HeadersInit, accountId?: string): Promise<Response> {
  const request = new Headers(headers);
  expect(request.get("Authorization")).toMatch(/^Bearer fixture-/);
  expect(request.get("ChatGPT-Account-Id")).toBe(accountId ?? null);
  return Promise.resolve(
    new Response(
      JSON.stringify({
        plan_type: "plus",
        rate_limit: { primary_window: { used_percent: 30, reset_at: 1700000000 } },
      }),
      { status: 200 },
    ),
  );
}

test("default input reads CODEX_HOME auth and preserves the usage request", async () => {
  const home = await mkdtemp(join(tmpdir(), "usage-codex-"));
  try {
    process.env["CODEX_HOME"] = home;
    await writeFile(
      join(home, "auth.json"),
      JSON.stringify({
        tokens: { access_token: "fixture-default", account_id: "account-default" },
      }),
    );
    const report = await fetchUsage({}, (_url, init) =>
      response(init?.headers ?? {}, "account-default"),
    );
    expect(report).toMatchObject({
      status: "available",
      planLabel: "plus",
      windows: [{ id: "session", usedPct: 30 }],
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("discovery input rejects explicit credential routes", () => {
  for (const input of [
    { codexHome: "/unused" },
    { accessToken: "unused" },
    { accessToken: "unused", accountId: "unused" },
  ]) {
    expect(inputSchema.safeParse(input).success).toBe(false);
  }
  expect(inputSchema.parse({})).toEqual({});
});

test("identify returns a key when fetch finds Codex token credentials", async () => {
  await writeAuth("fixture-supplied", "account-supplied");
  await fetchUsage({}, (_url, init) => response(init?.headers ?? {}, "account-supplied"));
  expect(await identify({})).toEqual({ key: "account-supplied" });
});

test("coerces credit balance and marks a 96 percent window dangerous", async () => {
  const report = await fetchUsage(
    {},
    async () =>
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 12 },
            secondary_window: { used_percent: 96 },
          },
          credits: { balance: "0" },
        }),
        { status: 200 },
      ),
  );
  expect(report.windows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "session", tone: "ok" }),
      expect.objectContaining({ id: "weekly", tone: "danger" }),
    ]),
  );
  expect(report.balances).toEqual([
    expect.objectContaining({ remaining: 0, unit: "credits", tone: "danger" }),
  ]);
});

test("summarizes the session and weekly windows by default, not code review", async () => {
  const report = await fetchUsage(
    {},
    async () =>
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 12 },
            secondary_window: { used_percent: 40 },
          },
          code_review_rate_limit: { primary_window: { used_percent: 5 } },
        }),
        { status: 200 },
      ),
  );
  expect(report.windows.map((window) => [window.id, window.summary ?? false])).toEqual([
    ["session", true],
    ["weekly", true],
    ["code_review", false],
  ]);
});

test("HTML usage body is unavailable", async () => {
  const report = await fetchUsage(
    {},
    async () => new Response("<html>Login</html>", { status: 200 }),
  );
  expect(report.status).toBe("unavailable");
});

test("401 leaves auth.json byte for byte unchanged and makes no refresh request", async () => {
  const home = await mkdtemp(join(tmpdir(), "usage-codex-"));
  try {
    process.env["CODEX_HOME"] = home;
    const authPath = join(home, "auth.json");
    const before = JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "fixture-id",
        access_token: "fixture-stale",
        refresh_token: "fixture-refresh",
        account_id: "fixture-account",
      },
      last_refresh: "2026-07-04T20:35:00Z",
    });
    await writeFile(authPath, before);
    let calls = 0;
    const report = await fetchUsage({}, async (url) => {
      expect(String(url)).toBe("https://chatgpt.com/backend-api/wham/usage");
      calls++;
      return new Response(null, { status: 401 });
    });
    expect(report.status).toBe("unavailable");
    expect(calls).toBe(1);
    expect(await readFile(authPath, "utf8")).toBe(before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("default auth account claim survives token rotation", async () => {
  const token = (suffix: string) =>
    `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "work-id" }, suffix })).toString("base64url")}.signature`;
  await writeAuth(token("first"));
  expect(await identify({})).toEqual({ key: "work-id" });
  await writeAuth(token("second"));
  expect(await identify({})).toEqual({ key: "work-id" });
  await writeAuth("opaque-token");
  expect(await identify({})).toBeNull();
});

test("identify reads an email label from auth id_token when access token has no profile", async () => {
  const home = await mkdtemp(join(tmpdir(), "usage-codex-label-"));
  try {
    process.env["CODEX_HOME"] = home;
    const idToken = `header.${Buffer.from(JSON.stringify({ email: "id-owner@example.test" })).toString("base64url")}.signature`;
    await writeFile(
      join(home, "auth.json"),
      JSON.stringify({
        tokens: { account_id: "account-id", access_token: "opaque-token", id_token: idToken },
      }),
    );
    expect(await identify({})).toEqual({
      key: "account-id",
      label: "id-owner@example.test",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
