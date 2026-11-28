import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discover,
  discoverSession,
  fetchUsage,
  readCursorAgentKeychainToken,
  type CursorKeychainReader,
  type SecurityCommandRunner,
} from "./usage.js";
import type { UsageReport } from "@getpaseo/plugin/server/usage";

// Discovery reads the macOS Keychain on darwin; tests pass this fake unless testing Keychain.
const noKeychain: CursorKeychainReader = async () => null;

function keychainReturning(token: string | null): CursorKeychainReader {
  return async () => token;
}

function jwtFor(sub: string, nonce: string): string {
  return `e30.${Buffer.from(JSON.stringify({ sub, nonce })).toString("base64url")}.signature`;
}

// node:sqlite has no @types/node@20 typings; require it with a narrow local type.
const testRequire = createRequire(import.meta.url);
interface TestSqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): void };
  close(): void;
}

// Cursor builds have stored ItemTable values as both TEXT and BLOB. Keys map to the
// real layouts: a plain modern token or the legacy JSON object.
function writeCursorStateDb(homeDir: string, rows: Record<string, string | Uint8Array>): void {
  writeCursorStateDbAt(join(homeDir, ".config", "Cursor", "User", "globalStorage"), rows);
}

function writeCursorStateDbAt(dir: string, rows: Record<string, string | Uint8Array>): void {
  mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = testRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => TestSqliteDb;
  };
  const db = new DatabaseSync(join(dir, "state.vscdb"));
  db.exec("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  const insert = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(rows)) {
    insert.run(key, value);
  }
  db.close();
}

function writeCursorAuthJson(homeDir: string, accessToken: string): void {
  writeCursorAuthJsonAt(join(homeDir, ".config", "cursor"), accessToken);
}

function writeCursorAuthJsonAt(dir: string, accessToken: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ accessToken }));
}

function mockFetch(handlers: Map<string, () => Response>): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL) => {
    const key = url.toString();
    const handler = handlers.get(key);
    if (!handler) throw new Error(`Unmocked fetch: ${key}`);
    return handler();
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("cursor usage source", () => {
  let homeDir: string;
  let fetchApi: typeof fetch;
  let originalEnv: Record<string, string | undefined>;
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "usage-home-"));
    originalEnv = { ...process.env };
    process.env["HOME"] = homeDir;
    process.env["USERPROFILE"] = homeDir;
    for (const key of [
      "APPDATA",
      "XDG_CONFIG_HOME",
      "COPILOT_TOKEN",
      "GITHUB_TOKEN",
      "GITHUB_PAT",
      "CURSOR_ACCESS_TOKEN",
      "CURSOR_TOKEN",
      "ZAI_API_KEY",
      "GLM_API_KEY",
      "GROK_API_KEY",
      "GROK_TOKEN",
      "KIMI_TOKEN",
      "KIMI_API_KEY",
      "KIMI_CODE_HOME",
      "MINIMAX_API_KEY",
      "MINIMAX_BASE_URL",
    ])
      delete process.env[key];
    fetchApi = mockFetch(new Map());
  });
  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    for (const key in originalEnv) process.env[key] = originalEnv[key];
  });
  function service(
    _options: {
      platform?: typeof process.platform;
      keychain?: () => Promise<unknown | null>;
      cursorHomeDir?: string;
      kimiHomeDir?: string;
    } = {},
  ) {
    return {
      listUsage: async () => {
        const report = await fetchFirst((url, init) => fetchApi(url, init));
        return {
          providers: [
            {
              providerId: "cursor",
              ...report,
              error: report.status === "error" ? report.error : null,
              planLabel: report.status === "available" ? (report.planLabel ?? null) : null,
            },
          ],
        };
      },
    };
  }
  function findProvider(
    result: { providers: Array<{ providerId: string } & UsageReport> },
    id: string,
  ) {
    const report = result.providers.find((item) => item.providerId === id);
    if (!report) throw new Error(`Missing usage source ${id}`);
    return report;
  }
  it("fetches Cursor usage and normalizes malformed billing dates to null", async () => {
    process.env["CURSOR_ACCESS_TOKEN"] = "cursor_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          () =>
            jsonResponse({
              planUsage: {
                totalSpend: "1500",
                includedSpend: "1000",
                bonusSpend: "500",
                remaining: "2500",
                limit: "4000",
              },
              billingCycleStart: "2026-01-14T12:42:14.000Z",
              billingCycleEnd: "not-a-date",
            }),
        ],
      ]),
    );

    const cursor = findProvider(await service().listUsage(), "cursor");

    expect(cursor).toMatchObject({
      status: "available",
      balances: [
        expect.objectContaining({
          id: "plan_usage",
          used: 15,
          remaining: 25,
          limit: 40,
          resetsAt: null,
        }),
      ],
    });
  });

  it("reads the Cursor token from the modern cursorAuth/accessToken key in state.vscdb", async () => {
    writeCursorStateDb(homeDir, { "cursorAuth/accessToken": "cursor_state_jwt" });
    let authorization: string | null = null;
    fetchApi = (async (url: RequestInfo | URL, init?: RequestInit) => {
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return jsonResponse({
        planUsage: {
          totalSpend: "1500",
          includedSpend: "1000",
          bonusSpend: "500",
          remaining: "2500",
          limit: "4000",
        },
        billingCycleStart: "2026-01-14T12:42:14.000Z",
        billingCycleEnd: "2026-02-14T12:42:14.000Z",
      });
    }) as unknown as typeof fetch;

    const cursor = findProvider(await service({ cursorHomeDir: homeDir }).listUsage(), "cursor");

    expect(authorization).toBe("Bearer cursor_state_jwt");
    expect(cursor).toMatchObject({
      status: "available",
      balances: [expect.objectContaining({ id: "plan_usage", used: 15, remaining: 25, limit: 40 })],
    });
  });

  it("falls back to the legacy cursorAuthStatus JSON blob when the modern key is absent", async () => {
    writeCursorStateDb(homeDir, {
      cursorAuthStatus: Buffer.from(JSON.stringify({ accessToken: "cursor_legacy_jwt" }), "utf8"),
    });
    let authorization: string | null = null;
    fetchApi = (async (url: RequestInfo | URL, init?: RequestInit) => {
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return jsonResponse({
        planUsage: { totalSpend: "0", remaining: "100", limit: "100" },
        billingCycleStart: null,
        billingCycleEnd: null,
      });
    }) as unknown as typeof fetch;

    const cursor = findProvider(await service({ cursorHomeDir: homeDir }).listUsage(), "cursor");

    expect(authorization).toBe("Bearer cursor_legacy_jwt");
    expect(cursor.status).toBe("available");
  });

  it("reads the Cursor token from cursor-agent ~/.config/cursor/auth.json when desktop state is absent", async () => {
    writeCursorAuthJson(homeDir, "cursor_cli_jwt");
    let authorization: string | null = null;
    fetchApi = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return jsonResponse({
        planUsage: {
          totalSpend: "1500",
          includedSpend: "1000",
          bonusSpend: "500",
          remaining: "2500",
          limit: "4000",
        },
        billingCycleStart: "2026-01-14T12:42:14.000Z",
        billingCycleEnd: "2026-02-14T12:42:14.000Z",
      });
    }) as unknown as typeof fetch;

    const cursor = findProvider(await service({ cursorHomeDir: homeDir }).listUsage(), "cursor");

    expect(authorization).toBe("Bearer cursor_cli_jwt");
    expect(cursor).toMatchObject({
      status: "available",
      balances: [expect.objectContaining({ id: "plan_usage", used: 15, remaining: 25, limit: 40 })],
    });
  });

  it("prefers the desktop state.vscdb token over cursor-agent auth.json", async () => {
    writeCursorStateDb(homeDir, { "cursorAuth/accessToken": "cursor_desktop_jwt" });
    writeCursorAuthJson(homeDir, "cursor_cli_jwt");
    let authorization: string | null = null;
    fetchApi = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return jsonResponse({
        planUsage: { totalSpend: "0", remaining: "100", limit: "100" },
        billingCycleStart: null,
        billingCycleEnd: null,
      });
    }) as unknown as typeof fetch;

    const cursor = findProvider(await service({ cursorHomeDir: homeDir }).listUsage(), "cursor");

    expect(authorization).toBe("Bearer cursor_desktop_jwt");
    expect(cursor.status).toBe("available");
  });

  it("omits unreadable state.vscdb", async () => {
    const directory = join(homeDir, ".config", "Cursor", "User", "globalStorage");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "state.vscdb"), "invalid database");
    expect(await discover({ readKeychain: noKeychain })).toEqual([]);
  });

  describe("session discovery", () => {
    let sessionHome: string;
    beforeEach(() => {
      sessionHome = mkdtempSync(join(tmpdir(), "usage-session-home-"));
    });
    afterEach(() => {
      rmSync(sessionHome, { recursive: true, force: true });
    });
    function cursorSession(env: Record<string, string>, provider = "cursor") {
      return { kind: "session" as const, provider, env: { HOME: sessionHome, ...env } };
    }
    function writeAuthJson(path: string, accessToken = "session-token"): void {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, JSON.stringify({ accessToken }));
    }

    it("keeps different accounts separate while joining global and session logins for the same account", async () => {
      writeCursorAuthJson(homeDir, jwtFor("user-a", "desktop"));
      writeCursorAuthJson(sessionHome, jwtFor("user-b", "session"));
      const globalAccounts = await discover({ readKeychain: noKeychain });
      const differentAccount = await discoverSession(cursorSession({}), "linux");
      expect(globalAccounts).toHaveLength(1);
      expect(differentAccount).toHaveLength(1);
      expect(differentAccount[0]!.key).not.toBe(globalAccounts[0]!.key);

      writeCursorAuthJson(sessionHome, jwtFor("user-a", "refreshed-session"));
      const sameAccount = await discoverSession(cursorSession({}), "linux");
      expect(sameAccount).toHaveLength(1);
      expect(sameAccount[0]!.key).toBe(globalAccounts[0]!.key);
    });

    it("isolates logins without a readable subject by store and keeps their key across token rotation", async () => {
      writeCursorAuthJson(homeDir, "opaque-global-token");
      writeCursorAuthJson(sessionHome, "opaque-session-token");
      const globalAccounts = await discover({ readKeychain: noKeychain });
      const sessionAccounts = await discoverSession(cursorSession({}), "linux");
      expect(sessionAccounts).toHaveLength(1);
      expect(globalAccounts).toHaveLength(1);
      expect(sessionAccounts[0]!.key).not.toBe(globalAccounts[0]!.key);
      writeCursorAuthJson(sessionHome, "e30.invalid-json.signature");
      expect(await discoverSession(cursorSession({}), "linux")).toEqual(sessionAccounts);
      writeCursorAuthJson(sessionHome, "e30.e30.signature");
      expect(await discoverSession(cursorSession({}), "linux")).toEqual(sessionAccounts);
    });

    it("reads the login cursor-agent uses under the session's XDG_CONFIG_HOME", async () => {
      const configHome = join(sessionHome, "xdg");
      const authPath = join(configHome, "cursor", "auth.json");
      writeAuthJson(authPath);
      expect(
        await discoverSession(cursorSession({ XDG_CONFIG_HOME: configHome }), "linux"),
      ).toEqual([
        {
          key: expect.stringMatching(/^store-[a-f0-9]{64}$/),
          input: { store: "file", locator: authPath },
        },
      ]);
    });

    it("reads the login under the session's HOME, not the daemon's", async () => {
      writeCursorAuthJson(homeDir, "daemon-token");
      writeCursorAuthJson(sessionHome, "session-token");
      expect(await discoverSession(cursorSession({}), "linux")).toEqual([
        {
          key: expect.stringMatching(/^store-[a-f0-9]{64}$/),
          input: { store: "file", locator: join(sessionHome, ".config", "cursor", "auth.json") },
        },
      ]);
    });

    it("reads %APPDATA%/Cursor/auth.json on Windows", async () => {
      const appData = join(sessionHome, "AppData", "Roaming");
      const authPath = join(appData, "Cursor", "auth.json");
      writeAuthJson(authPath);
      expect(await discoverSession(cursorSession({ APPDATA: appData }), "win32")).toEqual([
        {
          key: expect.stringMatching(/^store-[a-f0-9]{64}$/),
          input: { store: "file", locator: authPath },
        },
      ]);
    });

    it("reads ~/.cursor/auth.json on macOS only when cursor-agent uses the file store", async () => {
      const authPath = join(sessionHome, ".cursor", "auth.json");
      writeAuthJson(authPath);
      const services: string[] = [];
      const trackingNoKeychain: CursorKeychainReader = async (serviceName) => {
        services.push(serviceName);
        return null;
      };
      expect(await discoverSession(cursorSession({}), "darwin", trackingNoKeychain)).toEqual([]);
      expect(services).toEqual(["cursor-access-token"]);

      services.length = 0;
      expect(
        await discoverSession(
          cursorSession({ AGENT_CLI_CREDENTIAL_STORE: "file" }),
          "darwin",
          trackingNoKeychain,
        ),
      ).toEqual([
        {
          key: expect.stringMatching(/^store-[a-f0-9]{64}$/),
          input: { store: "file", locator: authPath },
        },
      ]);
      expect(services).toEqual([]);
    });

    it("reads cursor-agent's Keychain login on macOS by default", async () => {
      const services: string[] = [];
      const keychain: CursorKeychainReader = async (serviceName) => {
        services.push(serviceName);
        return jwtFor("user-mac", "keychain");
      };
      const accounts = await discoverSession(cursorSession({}), "darwin", keychain);
      expect(accounts).toEqual([
        {
          key: expect.stringMatching(/^account-[a-f0-9]{64}$/),
          input: { store: "keychain", locator: "cursor-access-token" },
        },
      ]);
      expect(services).toEqual(["cursor-access-token"]);
    });

    it("skips encrypted session tokens in auth.json and macOS Keychain", async () => {
      const encrypted = "cursor-safe-storage:v1:Y2lwaGVydGV4dA==";
      writeAuthJson(join(sessionHome, ".config", "cursor", "auth.json"), encrypted);
      expect(await discoverSession(cursorSession({}), "linux")).toEqual([]);
      expect(
        await discoverSession(cursorSession({}), "darwin", keychainReturning(encrypted)),
      ).toEqual([]);
    });

    it.each([
      ["another provider", cursorSession({}, "claude")],
      ["a CURSOR_API_KEY session", cursorSession({ CURSOR_API_KEY: "key" })],
      ["a CURSOR_AUTH_TOKEN session", cursorSession({ CURSOR_AUTH_TOKEN: "token" })],
      ["an in-memory credential store", cursorSession({ AGENT_CLI_CREDENTIAL_STORE: "memory" })],
    ])("returns no login for %s", async (_scenario, scope) => {
      writeCursorAuthJson(sessionHome, "session-token");
      expect(await discoverSession(scope, "linux")).toEqual([]);
    });

    it("never falls back to the daemon's default stores", async () => {
      writeCursorStateDb(homeDir, { "cursorAuth/accessToken": "desktop-token" });
      writeCursorAuthJson(homeDir, "daemon-token");
      process.env["CURSOR_ACCESS_TOKEN"] = "daemon-env-token";
      expect(await discoverSession(cursorSession({}), "linux")).toEqual([]);
    });
  });
});

it("discovery returns a locator when fetch finds cursor credentials", async () => {
  const previous = process.env["CURSOR_ACCESS_TOKEN"];
  const previousAppData = process.env["APPDATA"];
  const previousXdg = process.env["XDG_CONFIG_HOME"];
  const previousHome = process.env["HOME"];
  const previousUserProfile = process.env["USERPROFILE"];
  const directory = mkdtempSync(join(tmpdir(), "usage-env-"));
  try {
    delete process.env["APPDATA"];
    delete process.env["XDG_CONFIG_HOME"];
    process.env["HOME"] = directory;
    process.env["USERPROFILE"] = directory;
    process.env["CURSOR_ACCESS_TOKEN"] = "fixture-token";
    let requested = false;
    await fetchFirst(async () => {
      requested = true;
      return new Response(null, { status: 401 });
    });
    expect(requested).toBe(true);
    expect(await discover({ readKeychain: noKeychain })).toEqual([
      {
        key: expect.stringMatching(/^store-[a-f0-9]{64}$/),
        input: { store: "env", locator: "CURSOR_ACCESS_TOKEN" },
      },
    ]);
  } finally {
    if (previous === undefined) delete process.env["CURSOR_ACCESS_TOKEN"];
    else process.env["CURSOR_ACCESS_TOKEN"] = previous;
    if (previousAppData === undefined) delete process.env["APPDATA"];
    else process.env["APPDATA"] = previousAppData;
    if (previousXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = previousXdg;
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    if (previousUserProfile === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = previousUserProfile;
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("account discovery", () => {
  it.each(["empty home", "unrelated files"])("returns no accounts for %s", async (scenario) => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const directory = await mkdtemp(join(tmpdir(), "usage-empty-"));
    const original = { ...process.env };
    try {
      for (const key of Object.keys(process.env)) delete process.env[key];
      process.env.HOME = directory;
      process.env.USERPROFILE = directory;
      if (scenario === "unrelated files") await writeFile(join(directory, "unrelated.json"), "{}");
      expect(await discover({ readKeychain: noKeychain })).toEqual([]);
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, original);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function fetchFirst(fetchApi: typeof fetch) {
  const accounts = await discover({ readKeychain: noKeychain });
  const account = accounts[0];
  if (!account) throw new Error("No configured account");
  return fetchUsage(account.input as Parameters<typeof fetchUsage>[0], fetchApi, {
    readKeychain: noKeychain,
  });
}

it.each([401, 403])("reports an existing login rejected with HTTP %i", async (status) => {
  const previous = process.env["CURSOR_ACCESS_TOKEN"];
  try {
    process.env["CURSOR_ACCESS_TOKEN"] = "fixture-rejected-login";
    const report = await fetchUsage(
      { store: "env", locator: "CURSOR_ACCESS_TOKEN" },
      async () => new Response(null, { status }),
    );
    expect(report).toEqual({ status: "unavailable", problem: { kind: "rejected", status } });
  } finally {
    if (previous === undefined) delete process.env["CURSOR_ACCESS_TOKEN"];
    else process.env["CURSOR_ACCESS_TOKEN"] = previous;
  }
});

describe("cross-platform credential discovery and encrypted token handling", () => {
  const encryptedV1 = `cursor-safe-storage:v1:${Buffer.from("ciphertext").toString("base64")}`;
  const encryptedV99 = `cursor-safe-storage:v99:${Buffer.from("ciphertext").toString("base64")}`;
  let homeDir: string;
  let originalEnv: Record<string, string | undefined>;
  let authorizations: Array<string | null>;
  const recordingFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get("Authorization"));
    return jsonResponse({
      planUsage: { totalPercentUsed: 20, autoPercentUsed: 19, apiPercentUsed: 42 },
      billingCycleStart: null,
      billingCycleEnd: null,
    });
  }) as unknown as typeof fetch;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "usage-xplat-home-"));
    originalEnv = { ...process.env };
    process.env["HOME"] = homeDir;
    process.env["USERPROFILE"] = homeDir;
    for (const key of ["APPDATA", "XDG_CONFIG_HOME", "CURSOR_ACCESS_TOKEN", "CURSOR_TOKEN"]) {
      delete process.env[key];
    }
    authorizations = [];
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    for (const key in originalEnv) process.env[key] = originalEnv[key];
  });

  describe.each([
    ["modern state.vscdb (v1)", encryptedV1],
    ["modern state.vscdb (v99)", encryptedV99],
    ["legacy cursorAuthStatus", encryptedV1],
    ["auth.json", encryptedV1],
    ["CURSOR_ACCESS_TOKEN", encryptedV1],
    ["CURSOR_TOKEN", encryptedV1],
    ["macOS Keychain", encryptedV1],
  ])("encrypted %s", (store, encrypted) => {
    it("discovers no account and never sends ciphertext from a stored locator", async () => {
      let input: Parameters<typeof fetchUsage>[0];
      let readKeychain: CursorKeychainReader = noKeychain;
      let platform: NodeJS.Platform = "linux";

      if (store.startsWith("modern state.vscdb")) {
        writeCursorStateDb(homeDir, { "cursorAuth/accessToken": encrypted });
        input = {
          store: "sqlite",
          locator: join(homeDir, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
        };
      } else if (store === "legacy cursorAuthStatus") {
        writeCursorStateDb(homeDir, {
          cursorAuthStatus: Buffer.from(JSON.stringify({ accessToken: encrypted }), "utf8"),
        });
        input = {
          store: "sqlite",
          locator: join(homeDir, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
        };
      } else if (store === "auth.json") {
        writeCursorAuthJson(homeDir, encrypted);
        input = { store: "file", locator: join(homeDir, ".config", "cursor", "auth.json") };
      } else if (store === "macOS Keychain") {
        platform = "darwin";
        readKeychain = async () => encrypted;
        input = { store: "keychain", locator: "cursor-access-token" };
      } else {
        process.env[store] = encrypted;
        input = { store: "env", locator: store };
      }

      expect(await discover({ platform, readKeychain })).toEqual([]);
      await expect(fetchUsage(input, recordingFetch, { platform, readKeychain })).rejects.toThrow(
        "Cursor login store no longer exists",
      );
      expect(authorizations).toEqual([]);
    });
  });

  it("skips an encrypted desktop token and uses Linux ~/.config/cursor/auth.json", async () => {
    writeCursorStateDb(homeDir, { "cursorAuth/accessToken": encryptedV1 });
    writeCursorAuthJson(homeDir, "cursor_cli_jwt");

    const accounts = await discover({ platform: "linux", readKeychain: noKeychain });
    expect(accounts).toEqual([
      {
        key: expect.stringMatching(/^store-[a-f0-9]{64}$/),
        input: { store: "file", locator: join(homeDir, ".config", "cursor", "auth.json") },
      },
    ]);

    const report = await fetchUsage(
      accounts[0]!.input as Parameters<typeof fetchUsage>[0],
      recordingFetch,
    );
    expect(authorizations).toEqual(["Bearer cursor_cli_jwt"]);
    expect(report.status).toBe("available");
  });

  it("skips an encrypted desktop token on macOS and uses ~/.cursor/auth.json and Keychain in priority order", async () => {
    const macDbDir = join(
      homeDir,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
    );
    writeCursorStateDbAt(macDbDir, { "cursorAuth/accessToken": encryptedV1 });
    writeCursorAuthJsonAt(join(homeDir, ".cursor"), jwtFor("user-mac", "file"));
    const services: string[] = [];
    const readKeychain: CursorKeychainReader = async (service) => {
      services.push(service);
      return jwtFor("user-mac", "keychain");
    };

    const accounts = await discover({ platform: "darwin", readKeychain });
    expect(accounts).toEqual([
      {
        key: expect.stringMatching(/^account-[a-f0-9]{64}$/),
        input: { store: "file", locator: join(homeDir, ".cursor", "auth.json") },
      },
      {
        key: expect.stringMatching(/^account-[a-f0-9]{64}$/),
        input: { store: "keychain", locator: "cursor-access-token" },
      },
    ]);
    expect(accounts[0]!.key).toBe(accounts[1]!.key);
    expect(services).toEqual(["cursor-access-token"]);

    const report = await fetchUsage(
      accounts[1]!.input as Parameters<typeof fetchUsage>[0],
      recordingFetch,
      { platform: "darwin", readKeychain },
    );
    expect(authorizations).toEqual([`Bearer ${jwtFor("user-mac", "keychain")}`]);
    expect(report).toMatchObject({
      status: "available",
      windows: [
        expect.objectContaining({ id: "plan_usage", usedPct: 20 }),
        expect.objectContaining({ id: "cursor_usage", usedPct: 19 }),
        expect.objectContaining({ id: "third_party_usage", usedPct: 42 }),
      ],
    });
  });

  it("falls back to macOS Keychain when desktop state.vscdb is encrypted and no auth.json exists", async () => {
    const macDbDir = join(
      homeDir,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
    );
    writeCursorStateDbAt(macDbDir, { "cursorAuth/accessToken": encryptedV1 });
    const readKeychain: CursorKeychainReader = async () => "cursor_keychain_jwt";

    const accounts = await discover({ platform: "darwin", readKeychain });
    expect(accounts).toEqual([
      {
        key: expect.stringMatching(/^store-[a-f0-9]{64}$/),
        input: { store: "keychain", locator: "cursor-access-token" },
      },
    ]);

    const report = await fetchUsage(
      accounts[0]!.input as Parameters<typeof fetchUsage>[0],
      recordingFetch,
      { platform: "darwin", readKeychain },
    );
    expect(authorizations).toEqual(["Bearer cursor_keychain_jwt"]);
    expect(report.status).toBe("available");
  });

  it("never reads macOS Keychain on Linux or Windows", async () => {
    const services: string[] = [];
    const readKeychain: CursorKeychainReader = async (service) => {
      services.push(service);
      return "cursor_keychain_jwt";
    };

    expect(await discover({ platform: "linux", readKeychain })).toEqual([]);
    expect(await discover({ platform: "win32", readKeychain })).toEqual([]);
    expect(services).toEqual([]);
  });

  it("reads cursor-agent's macOS Keychain item with the security CLI", async () => {
    const calls: string[][] = [];
    const run: SecurityCommandRunner = async (args) => {
      calls.push(args);
      return calls.length === 1 ? "cursor_keychain_jwt" : null;
    };

    expect(await readCursorAgentKeychainToken("cursor-access-token", run)).toBe(
      "cursor_keychain_jwt",
    );
    expect(await readCursorAgentKeychainToken("cursor-access-token", run)).toBeNull();
    expect(calls).toEqual([
      ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"],
      ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"],
    ]);
  });

  it("discovers Windows %APPDATA%\\Cursor\\auth.json alongside state.vscdb in priority order", async () => {
    const appData = join(homeDir, "AppData", "Roaming");
    process.env["APPDATA"] = appData;
    writeCursorStateDbAt(join(appData, "Cursor", "User", "globalStorage"), {
      "cursorAuth/accessToken": jwtFor("user-win", "desktop"),
    });
    writeCursorAuthJsonAt(join(appData, "Cursor"), jwtFor("user-win", "agent"));

    const accounts = await discover({ platform: "win32", readKeychain: noKeychain });
    expect(accounts).toEqual([
      {
        key: expect.stringMatching(/^account-[a-f0-9]{64}$/),
        input: {
          store: "sqlite",
          locator: join(appData, "Cursor", "User", "globalStorage", "state.vscdb"),
        },
      },
      {
        key: expect.stringMatching(/^account-[a-f0-9]{64}$/),
        input: { store: "file", locator: join(appData, "Cursor", "auth.json") },
      },
    ]);
    expect(accounts[0]!.key).toBe(accounts[1]!.key);
  });

  it("discovers Windows %APPDATA%\\Cursor\\auth.json when state.vscdb is encrypted and when APPDATA defaults from home", async () => {
    const appData = join(homeDir, "AppData", "Roaming");
    writeCursorStateDbAt(join(appData, "Cursor", "User", "globalStorage"), {
      "cursorAuth/accessToken": encryptedV1,
    });
    writeCursorAuthJsonAt(join(appData, "Cursor"), "cursor_win_cli_jwt");

    const accounts = await discover({ platform: "win32", readKeychain: noKeychain });
    expect(accounts).toEqual([
      {
        key: expect.stringMatching(/^store-[a-f0-9]{64}$/),
        input: { store: "file", locator: join(appData, "Cursor", "auth.json") },
      },
    ]);
  });

  it("deduplicates identical tokens while preserving all distinct candidates in priority order", async () => {
    const shared = jwtFor("user-1", "shared");
    const backup = jwtFor("user-1", "backup");
    process.env["CURSOR_ACCESS_TOKEN"] = shared;
    writeCursorStateDb(homeDir, { "cursorAuth/accessToken": shared });
    writeCursorAuthJson(homeDir, backup);

    const accounts = await discover({ platform: "linux", readKeychain: noKeychain });
    expect(accounts).toEqual([
      {
        key: expect.stringMatching(/^account-[a-f0-9]{64}$/),
        input: { store: "env", locator: "CURSOR_ACCESS_TOKEN" },
      },
      {
        key: expect.stringMatching(/^account-[a-f0-9]{64}$/),
        input: { store: "file", locator: join(homeDir, ".config", "cursor", "auth.json") },
      },
    ]);
    expect(accounts[0]!.key).toBe(accounts[1]!.key);
  });
});
