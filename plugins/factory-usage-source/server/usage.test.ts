import { createCipheriv, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inputSchema, type UsageInput } from "../shared/input.js";
import { discover, fetchUsage } from "./usage.js";

const NOW = Date.parse("2026-10-29T18:00:00.000Z");
const LIMITS_URL = "https://api.factory.ai/api/billing/limits";

function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64")).join(":");
}

function jwt(claims: object): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

function token(overrides: object = {}): string {
  return jwt({ sub: "user_fixture", org_id: "org_fixture", exp: NOW / 1000 + 3600, ...overrides });
}

function writeLogin(
  dir: string,
  file: string,
  key: Buffer,
  credentials: Record<string, unknown> = {},
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, file),
    encrypt(
      JSON.stringify({
        access_token: token(),
        refresh_token: "fixture-refresh",
        active_organization_id: "org_fixture",
        ...credentials,
      }),
      key,
    ),
  );
}

function bucket(usedPercent: number, windowEnd: string) {
  return { usedPercent, windowEnd, secondsRemaining: 1 };
}

const LIMITS = {
  usesTokenRateLimitsBilling: true,
  limits: {
    standard: {
      fiveHour: bucket(9, "2026-10-29T22:06:09.463Z"),
      weekly: bucket(11, "2026-10-30T14:30:16.153Z"),
      monthly: bucket(100, "2026-11-07T19:09:52.366Z"),
    },
    core: {
      fiveHour: bucket(7, "2026-10-29T22:51:01.392Z"),
      weekly: bucket(4, "2026-11-05T17:51:01.392Z"),
      monthly: bucket(43, "2026-11-01T17:45:06.664Z"),
    },
  },
  overagePreference: "droidCore",
  canManageOverage: true,
  extraUsageBalanceCents: 1250,
  extraUsageAllowed: true,
};

function limitsFetch(body: unknown = LIMITS, status = 200) {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(body, { status }),
  );
}

describe("factory usage source", () => {
  let home: string;
  let factoryDir: string;
  let key: Buffer;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "factory-usage-"));
    factoryDir = join(home, ".factory");
    key = randomBytes(32);
    env = { HOME: home };
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function keyring() {
    return vi.fn(async () => key.toString("base64"));
  }

  async function discoverLinux(readSecret = keyring()) {
    return discover({ kind: "global" }, { env, platform: "linux", readSecret });
  }

  async function fetchFirst(fetchApi: typeof fetch, readSecret = keyring()) {
    const accounts = await discoverLinux(readSecret);
    const account = accounts[0];
    if (!account) throw new Error("No Factory account discovered");
    return fetchUsage(inputSchema.parse(account.input), fetchApi, {
      env,
      platform: "linux",
      readSecret,
      now: () => NOW,
    });
  }

  it("reports Standard and Droid Core windows, extra usage, and the overage choice", async () => {
    writeLogin(factoryDir, "auth.v2.keyring", key);
    const fetchApi = limitsFetch();

    const report = await fetchFirst(fetchApi as unknown as typeof fetch);

    expect(fetchApi).toHaveBeenCalledTimes(1);
    const [url, init] = fetchApi.mock.calls[0]!;
    expect(String(url)).toBe(LIMITS_URL);
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${token()}`,
      "X-Factory-Org-Id": "org_fixture",
    });
    expect(report).toEqual({
      status: "available",
      windows: [
        {
          id: "five_hour",
          label: "5-hour",
          shortLabel: "5h",
          summary: true,
          usedPct: 9,
          remainingPct: 91,
          resetsAt: "2026-10-29T22:06:09.463Z",
          tone: "ok",
        },
        {
          id: "weekly",
          label: "Weekly",
          shortLabel: "wk",
          summary: true,
          usedPct: 11,
          remainingPct: 89,
          resetsAt: "2026-10-30T14:30:16.153Z",
          tone: "ok",
        },
        {
          id: "monthly",
          label: "Monthly",
          shortLabel: "mo",
          usedPct: 100,
          remainingPct: 0,
          resetsAt: "2026-11-07T19:09:52.366Z",
          tone: "danger",
        },
        expect.objectContaining({ id: "core:five_hour", label: "Droid Core · 5-hour", usedPct: 7 }),
        expect.objectContaining({ id: "core:weekly", shortLabel: "Core wk", usedPct: 4 }),
        expect.objectContaining({ id: "core:monthly", usedPct: 43 }),
      ],
      balances: [
        { id: "extra_usage", label: "Extra usage", remaining: 12.5, unit: "usd", tone: "ok" },
      ],
      details: [{ id: "overage", label: "When Standard runs out", value: "Switch to Droid Core" }],
    });
  });

  it("treats a window whose end has passed as rolled over", async () => {
    writeLogin(factoryDir, "auth.v2.keyring", key);
    const body = structuredClone(LIMITS);
    body.limits.standard.fiveHour = bucket(80, "2026-10-29T17:00:00.000Z");

    const report = await fetchFirst(limitsFetch(body) as unknown as typeof fetch);

    expect(report.status === "available" && report.windows[0]).toMatchObject({
      id: "five_hour",
      usedPct: 0,
      resetsAt: null,
    });
  });

  it("falls back to auth.v2.file and auth.v2.key when the keyring has no key", async () => {
    writeLogin(factoryDir, "auth.v2.file", key);
    writeFileSync(join(factoryDir, "auth.v2.key"), key.toString("base64"));
    const readSecret = vi.fn(async () => null);

    const accounts = await discoverLinux(readSecret);

    expect(accounts).toEqual([
      {
        key: expect.stringMatching(/^[0-9a-f]{64}$/),
        harness: "Droid",
        input: { store: "login", factoryDir, keyStore: "file" },
      },
    ]);
    expect((await fetchFirst(limitsFetch() as unknown as typeof fetch, readSecret)).status).toBe(
      "available",
    );
  });

  it("prefers the keyring login over an older key file login, as the CLI does", async () => {
    writeLogin(factoryDir, "auth.v2.keyring", key);
    writeLogin(factoryDir, "auth.v2.file", key);
    writeFileSync(join(factoryDir, "auth.v2.key"), key.toString("base64"));

    const accounts = await discoverLinux();

    expect(accounts.map((account) => account.input)).toEqual([
      { store: "login", factoryDir, keyStore: "keyring" },
    ]);
  });

  it("uses the macOS login Keychain store on darwin", async () => {
    writeLogin(factoryDir, "auth.v2.loginkeychain", key);
    const readSecret = vi.fn(async () => key.toString("base64"));

    const accounts = await discover({ kind: "global" }, { env, platform: "darwin", readSecret });

    expect(readSecret).toHaveBeenCalledWith("keychain");
    expect(accounts.map((account) => account.input)).toEqual([
      { store: "login", factoryDir, keyStore: "keychain" },
    ]);
  });

  it("keeps the account key stable across token rotation", async () => {
    writeLogin(factoryDir, "auth.v2.keyring", key);
    const first = await discoverLinux();
    writeLogin(factoryDir, "auth.v2.keyring", key, { access_token: token({ exp: 1 }) });

    expect((await discoverLinux())[0]?.key).toBe(first[0]?.key);
  });

  it("reports an expired login without calling the API or touching the store", async () => {
    writeLogin(factoryDir, "auth.v2.keyring", key, {
      access_token: token({ exp: NOW / 1000 - 60 }),
    });
    const before = readFileSync(join(factoryDir, "auth.v2.keyring"), "utf8");
    const fetchApi = limitsFetch();

    const report = await fetchFirst(fetchApi as unknown as typeof fetch);

    expect(report).toEqual({
      status: "unavailable",
      problem: {
        kind: "expired",
        expiresAt: new Date(NOW - 60_000).toISOString(),
        refreshedBy: "droid",
      },
    });
    expect(fetchApi).not.toHaveBeenCalled();
    expect(readFileSync(join(factoryDir, "auth.v2.keyring"), "utf8")).toBe(before);
  });

  it.each([401, 403])("reports a login rejected with HTTP %i", async (status) => {
    writeLogin(factoryDir, "auth.v2.keyring", key);

    const report = await fetchFirst(limitsFetch({}, status) as unknown as typeof fetch);

    expect(report).toEqual({
      status: "unavailable",
      problem: { kind: "rejected", status, refreshedBy: "droid" },
    });
  });

  it("reports no quota when the plan has no Standard limits", async () => {
    writeLogin(factoryDir, "auth.v2.keyring", key);

    const report = await fetchFirst(limitsFetch({ limits: {} }) as unknown as typeof fetch);

    expect(report).toMatchObject({ status: "unavailable", problem: { kind: "no_quota" } });
  });

  it("routes EU logins to the EU API", async () => {
    writeLogin(factoryDir, "auth.v2.keyring", key, { whoami: { region: "eu" } });
    const fetchApi = limitsFetch();

    await fetchFirst(fetchApi as unknown as typeof fetch);

    expect(String(fetchApi.mock.calls[0]![0])).toBe("https://api.eu.factory.ai/api/billing/limits");
  });

  it("lists FACTORY_API_KEY before the stored login and sends it as a bearer token", async () => {
    env.FACTORY_API_KEY = "fk-fixture";
    writeLogin(factoryDir, "auth.v2.keyring", key);
    const fetchApi = limitsFetch();

    const accounts = await discoverLinux();
    const report = await fetchUsage(
      inputSchema.parse(accounts[0]!.input),
      fetchApi as unknown as typeof fetch,
      { env, now: () => NOW },
    );

    expect(accounts.map((account) => account.input)).toEqual([
      { store: "env", locator: "FACTORY_API_KEY" },
      { store: "login", factoryDir, keyStore: "keyring" },
    ]);
    expect(report.status).toBe("available");
    expect(fetchApi.mock.calls[0]![1]?.headers).toMatchObject({
      Authorization: "Bearer fk-fixture",
    });
  });

  it("skips on-prem logins", async () => {
    writeLogin(factoryDir, "auth.v2.keyring", key, { whoami: { isOnPrem: true } });

    expect(await discoverLinux()).toEqual([]);
  });

  it("finds no account when the store is missing or the key does not decrypt it", async () => {
    expect(await discoverLinux()).toEqual([]);
    writeLogin(factoryDir, "auth.v2.keyring", randomBytes(32));
    expect(await discoverLinux()).toEqual([]);
  });

  it("does not discover sessions", async () => {
    writeLogin(factoryDir, "auth.v2.keyring", key);

    expect(
      await discover(
        { kind: "session", provider: "acp", env: { HOME: home } },
        { env, platform: "linux", readSecret: keyring() },
      ),
    ).toEqual([]);
  });

  it("throws when the discovered login store disappears", async () => {
    const input: UsageInput = { store: "login", factoryDir, keyStore: "keyring" };

    await expect(
      fetchUsage(input, limitsFetch() as unknown as typeof fetch, {
        env,
        readSecret: keyring(),
        now: () => NOW,
      }),
    ).rejects.toThrow("Factory login store no longer exists");
  });
});
