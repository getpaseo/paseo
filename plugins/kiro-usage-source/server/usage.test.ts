import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kiroDatabasePath, readKiroLogin } from "./store.js";
import { discover, fetchUsage } from "./usage.js";

const PROFILE_ARN = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABCDEF";
const NOW = Date.parse("2026-11-28T12:00:00Z");

async function writeStore(
  path: string,
  auth: Record<string, unknown>,
  state: Record<string, unknown> = {},
) {
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
  db.exec("CREATE TABLE state (key TEXT PRIMARY KEY, value BLOB)");
  for (const [key, value] of Object.entries(auth))
    db.prepare("INSERT INTO auth_kv VALUES (?, ?)").run(key, JSON.stringify(value));
  for (const [key, value] of Object.entries(state))
    db.prepare("INSERT INTO state VALUES (?, ?)").run(key, JSON.stringify(value));
  db.close();
}

function idcToken(overrides: Record<string, unknown> = {}) {
  return {
    access_token: "aoa-access",
    refresh_token: "aor-refresh",
    expires_at: "2026-11-28T13:00:00Z",
    region: "us-east-1",
    start_url: "https://d-123.awsapps.com/start",
    ...overrides,
  };
}

const powerResponse = {
  daysUntilReset: 0,
  nextDateReset: 1796083200,
  overageConfiguration: { overageLimit: null, overageStatus: "DISABLED" },
  subscriptionInfo: { subscriptionTitle: "KIRO POWER", type: "Q_DEVELOPER_STANDALONE_POWER" },
  usageBreakdownList: [
    {
      currency: "USD",
      currentUsage: 6843,
      currentUsageWithPrecision: 6843.65,
      displayName: "Credit",
      displayNamePlural: "Credits",
      freeTrialInfo: null,
      nextDateReset: 1796083200,
      overageCharges: 0,
      resourceType: "CREDIT",
      usageLimit: 10000,
      usageLimitWithPrecision: 10000,
    },
  ],
  userInfo: { email: null, userId: "d-123.user" },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("kiro usage source", () => {
  let home: string;
  let path: string;
  const lookup = () => ({ home, platform: "linux" as const, env: {}, now: () => NOW });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kiro-usage-"));
    path = kiroDatabasePath({ home, platform: "linux", env: {} });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("resolves the store under each platform's local data directory", () => {
    expect(kiroDatabasePath({ home: "/h", platform: "darwin", env: {} })).toBe(
      "/h/Library/Application Support/kiro-cli/data.sqlite3",
    );
    expect(kiroDatabasePath({ home: "/h", platform: "linux", env: {} })).toBe(
      "/h/.local/share/kiro-cli/data.sqlite3",
    );
    expect(kiroDatabasePath({ home: "/h", platform: "linux", env: { XDG_DATA_HOME: "/x" } })).toBe(
      "/x/kiro-cli/data.sqlite3",
    );
    expect(kiroDatabasePath({ home: "/h", platform: "win32", env: { LOCALAPPDATA: "/l" } })).toBe(
      join("/l", "kiro-cli", "data.sqlite3"),
    );
  });

  it("reads an IAM Identity Center login with the profile from state", async () => {
    await writeStore(
      path,
      { "kirocli:odic:token": idcToken() },
      { "api.codewhisperer.profile": { arn: PROFILE_ARN, profile_name: "QDevProfile" } },
    );
    expect(readKiroLogin(path)).toEqual({
      kind: "kirocli:odic:token",
      accessToken: "aoa-access",
      expiresAt: Date.parse("2026-11-28T13:00:00Z"),
      region: "us-east-1",
      startUrl: "https://d-123.awsapps.com/start",
      profileArn: PROFILE_ARN,
    });
  });

  it("reads the profile ARN a social login stores on its token", async () => {
    await writeStore(path, {
      "kirocli:social:token": {
        access_token: "social-access",
        expires_at: "2026-11-28T13:00:00Z",
        profile_arn: PROFILE_ARN,
      },
    });
    expect(readKiroLogin(path)).toMatchObject({
      kind: "kirocli:social:token",
      profileArn: PROFILE_ARN,
    });
  });

  it("discovers no account without a login or for other providers", async () => {
    expect(await discover({ kind: "global" }, lookup())).toEqual([]);
    await writeStore(path, { "kirocli:odic:token": idcToken() });
    expect(
      await discover({ kind: "session", provider: "claude", env: { HOME: home } }, lookup()),
    ).toEqual([]);
  });

  it("discovers the same account globally and for Kiro sessions", async () => {
    await writeStore(path, { "kirocli:odic:token": idcToken() });
    const [global] = await discover({ kind: "global" }, lookup());
    const [session] = await discover(
      { kind: "session", provider: "kiro", env: { HOME: home } },
      lookup(),
    );
    expect(global).toMatchObject({ harness: "Kiro CLI", provider: "kiro", input: { path } });
    expect(global!.key).toMatch(/^[a-f0-9]{64}$/);
    expect(session).toEqual(global);
  });

  it("reports credits as a monthly window with the plan and overage status", async () => {
    await writeStore(
      path,
      { "kirocli:odic:token": idcToken() },
      { "api.codewhisperer.profile": { arn: PROFILE_ARN } },
    );
    const fetchApi = vi.fn(async () => jsonResponse(powerResponse));
    const report = await fetchUsage({ path }, fetchApi as unknown as typeof fetch, lookup());

    const [url, init] = fetchApi.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.origin).toBe("https://q.eu-central-1.amazonaws.com");
    expect(url.pathname).toBe("/getUsageLimits");
    expect(url.searchParams.get("profileArn")).toBe(PROFILE_ARN);
    expect(url.searchParams.get("origin")).toBe("KIRO_CLI");
    expect(init.headers).toMatchObject({ Authorization: "Bearer aoa-access" });

    expect(report).toEqual({
      status: "available",
      planLabel: "KIRO POWER",
      windows: [
        {
          id: "credit",
          label: "Credits",
          summary: true,
          usedPct: 68.44,
          remainingPct: 31.56,
          resetsAt: "2026-12-01T00:00:00.000Z",
          tone: "ok",
        },
      ],
      balances: [],
      details: [
        { id: "credit_used", label: "Credits used", value: "6,843.65 / 10,000" },
        { id: "overage", label: "Overage", value: "Disabled" },
      ],
    });
  });

  it("reports an active free trial and overage charges", async () => {
    await writeStore(path, { "kirocli:odic:token": idcToken() });
    const body = structuredClone(powerResponse) as Record<string, unknown>;
    body.usageBreakdownList = [
      {
        ...powerResponse.usageBreakdownList[0],
        currentUsageWithPrecision: 9500,
        overageCharges: 12.5,
        freeTrialInfo: {
          currentUsageWithPrecision: 100,
          usageLimitWithPrecision: 500,
          freeTrialExpiry: 1796083200,
          freeTrialStatus: "ACTIVE",
        },
      },
    ];
    const report = await fetchUsage(
      { path },
      (async () => jsonResponse(body)) as unknown as typeof fetch,
      lookup(),
    );
    if (report.status !== "available") throw new Error("expected usage");
    expect(report.windows.map((window) => [window.id, window.usedPct, window.tone])).toEqual([
      ["credit", 95, "danger"],
      ["credit:free_trial", 20, "ok"],
    ]);
    expect(report.details).toContainEqual({
      id: "credit_overage_charges",
      label: "Overage charges",
      value: "$12.50",
      tone: "warning",
    });
    expect(report.details).toContainEqual({
      id: "credit_free_trial_expiry",
      label: "Free trial ends",
      value: "2026-12-01T00:00:00.000Z",
    });
  });

  it("does not call the API with an expired token", async () => {
    await writeStore(path, {
      "kirocli:odic:token": idcToken({ expires_at: "2026-11-28T11:00:00Z" }),
    });
    const fetchApi = vi.fn();
    expect(await fetchUsage({ path }, fetchApi as unknown as typeof fetch, lookup())).toEqual({
      status: "unavailable",
      problem: { kind: "expired", expiresAt: "2026-11-28T11:00:00.000Z", refreshedBy: "kiro" },
    });
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it("reports a rejected token", async () => {
    await writeStore(path, { "kirocli:odic:token": idcToken() });
    const report = await fetchUsage(
      { path },
      (async () => jsonResponse({ message: "denied" }, 403)) as unknown as typeof fetch,
      lookup(),
    );
    expect(report).toEqual({
      status: "unavailable",
      problem: { kind: "rejected", status: 403, refreshedBy: "kiro" },
    });
  });

  it("falls back to the login region when no profile is stored", async () => {
    await writeStore(path, { "kirocli:odic:token": idcToken({ region: "us-west-2" }) });
    const fetchApi = vi.fn(async () => jsonResponse(powerResponse));
    await fetchUsage({ path }, fetchApi as unknown as typeof fetch, lookup());
    const [url] = fetchApi.mock.calls[0] as unknown as [URL];
    expect(url.origin).toBe("https://q.us-west-2.amazonaws.com");
    expect(url.searchParams.has("profileArn")).toBe(false);
  });
});
