import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "./usage.js";
import type { UsageReport } from "@getpaseo/plugin/server/usage";

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
  const dir = join(homeDir, ".config", "Cursor", "User", "globalStorage");
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
  const dir = join(homeDir, ".config", "cursor");
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
        const report = await fetchUsage({}, (url, init) => fetchApi(url, init));
        return {
          providers: [
            {
              providerId: "cursor",
              ...report,
              error: report.error ?? null,
              planLabel: report.planLabel ?? null,
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

  it("stays unavailable when state.vscdb is unreadable", async () => {
    const path = join(homeDir, ".config", "Cursor", "User", "globalStorage");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "state.vscdb"), "not a database");
    const cursor = findProvider(await service().listUsage(), "cursor");
    expect(cursor.status).toBe("unavailable");
  });
});
