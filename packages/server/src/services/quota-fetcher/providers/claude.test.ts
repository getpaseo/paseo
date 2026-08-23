import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeQuotaProvider } from "./claude.js";

const logger = pino({ level: "silent" });

function forbiddenResponse(): Response {
  return new Response(JSON.stringify({ error: { type: "forbidden" } }), { status: 403 });
}

describe("ClaudeQuotaProvider forbidden handling", () => {
  it("surfaces a 403 as an error state instead of a silent blank card", async () => {
    // Keychain-sourced credentials (filePath null); a 403 must not be treated as a stale
    // token and must not blank out silently.
    const provider = new ClaudeQuotaProvider({
      logger,
      platform: "darwin",
      claudeHome: "/nonexistent-claude-home",
      claudeKeychainReader: async () => ({
        claudeAiOauth: { accessToken: "t", refreshToken: "r" },
      }),
      fetch: async () => forbiddenResponse(),
    });

    const usage = await provider.fetchUsage();

    expect(usage.status).toBe("error");
    expect(usage.error).toMatch(/refused \(HTTP 403\)/i);
    expect(usage.windows).toHaveLength(0);
  });

  it("does not attempt a token refresh on a 403", async () => {
    let refreshCalls = 0;
    const provider = new ClaudeQuotaProvider({
      logger,
      platform: "darwin",
      claudeHome: "/nonexistent-claude-home",
      claudeKeychainReader: async () => ({
        claudeAiOauth: { accessToken: "t", refreshToken: "r" },
      }),
      fetch: async (input) => {
        if (String(input).includes("/oauth/token")) {
          refreshCalls += 1;
          return new Response(JSON.stringify({ access_token: "new" }), { status: 200 });
        }
        return forbiddenResponse();
      },
    });

    const usage = await provider.fetchUsage();

    expect(refreshCalls).toBe(0);
    expect(usage.status).toBe("error");
  });

  it("reports plain unavailable when no credentials exist", async () => {
    const provider = new ClaudeQuotaProvider({
      logger,
      platform: "linux",
      claudeHome: "/nonexistent-claude-home",
      claudeKeychainReader: async () => null,
      fetch: async () => new Response("{}", { status: 200 }),
    });

    const usage = await provider.fetchUsage();

    expect(usage.status).toBe("unavailable");
    expect(usage.error).toBeNull();
  });
});

describe("ClaudeQuotaProvider refresh-then-forbidden", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "claude-quota-"));
    writeFileSync(
      join(home, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "stale", refreshToken: "r" } }),
    );
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("surfaces the forbidden message when a refreshed token is still forbidden", async () => {
    // File-based creds -> the 401 refresh path runs; the retried call then returns 403,
    // which must map to the explicit message, not generic unavailable.
    let usageCalls = 0;
    const provider = new ClaudeQuotaProvider({
      logger,
      platform: "linux",
      claudeHome: home,
      claudeKeychainReader: async () => null,
      fetch: async (input) => {
        if (String(input).includes("/oauth/token")) {
          return new Response(JSON.stringify({ access_token: "fresh" }), { status: 200 });
        }
        usageCalls += 1;
        return usageCalls === 1 ? new Response("{}", { status: 401 }) : forbiddenResponse();
      },
    });

    const usage = await provider.fetchUsage();

    expect(usageCalls).toBe(2);
    expect(usage.status).toBe("error");
    expect(usage.error).toMatch(/refused \(HTTP 403\)/i);
  });
});
