import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeQuotaProvider } from "./claude.js";

describe("Claude quota credential source", () => {
  let homeDir: string;
  let credentialPath: string;
  const fileContents = JSON.stringify({
    claudeAiOauth: { accessToken: "stale-file", expiresAt: null },
    mcpOAuth: { untouched: "MCP credential" },
  });

  beforeEach(async () => {
    vi.stubEnv("CLAUDE_HOME", "");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    homeDir = await mkdtemp(join(tmpdir(), "claude-usage-source-"));
    await mkdir(join(homeDir, ".claude"));
    credentialPath = join(homeDir, ".claude", ".credentials.json");
    await writeFile(credentialPath, fileContents);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(homeDir, { recursive: true, force: true });
  });

  it("reads the live default macOS Keychain instead of an abandoned file", async () => {
    const calls: string[] = [];
    const provider = new ClaudeQuotaProvider({
      logger: pino({ level: "silent" }),
      homeDir,
      platform: "darwin",
      claudeKeychainReader: async () => ({
        claudeAiOauth: { accessToken: "live-keychain", subscriptionType: "max" },
      }),
      fetch: async (url, init) => {
        expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
        const token = new Headers(init?.headers).get("Authorization")!;
        calls.push(token);
        if (token === "Bearer stale-file") return new Response(null, { status: 401 });
        return Response.json({ five_hour: { utilization: 11 }, seven_day: { utilization: 2 } });
      },
    });

    const result = await provider.fetchUsage();

    expect(result.status).toBe("available");
    expect(result.planLabel).toBe("Max");
    expect(result.windows.map((window) => window.usedPct)).toEqual([11, 2]);
    expect(calls).toEqual(["Bearer live-keychain"]);
    expect(await readFile(credentialPath, "utf8")).toBe(fileContents);
  });

  it.each([401, 403, 429, 500])(
    "does not switch accounts after Keychain HTTP %i",
    async (status) => {
      let calls = 0;
      const provider = new ClaudeQuotaProvider({
        logger: pino({ level: "silent" }),
        homeDir,
        platform: "darwin",
        claudeKeychainReader: async () => ({ claudeAiOauth: { accessToken: "account-a" } }),
        fetch: async (_url, init) => {
          calls++;
          expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer account-a");
          return new Response(null, { status });
        },
      });
      if (status === 401 || status === 403) {
        expect((await provider.fetchUsage()).status).toBe("unavailable");
      } else {
        await expect(provider.fetchUsage()).rejects.toThrow(`Claude usage API returned ${status}`);
      }
      expect(calls).toBe(1);
      expect(await readFile(credentialPath, "utf8")).toBe(fileContents);
    },
  );

  it.each(["linux", "win32"] as const)("does not consult Keychain on %s", async (platform) => {
    const provider = new ClaudeQuotaProvider({
      logger: pino({ level: "silent" }),
      homeDir,
      platform,
      claudeKeychainReader: async () => {
        throw new Error("Keychain must not be used");
      },
      fetch: async (_url, init) => {
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer stale-file");
        return Response.json({ five_hour: { utilization: 20 } });
      },
    });
    expect((await provider.fetchUsage()).windows[0].usedPct).toBe(20);
  });

  it.each(["option", "CLAUDE_CONFIG_DIR", "CLAUDE_HOME"])(
    "keeps %s isolated from the default account",
    async (setting) => {
      const customHome = join(homeDir, "account-b");
      await mkdir(customHome);
      const customPath = join(customHome, ".credentials.json");
      const contents = JSON.stringify({ claudeAiOauth: { accessToken: "account-b" } });
      await writeFile(customPath, contents);
      if (setting !== "option") vi.stubEnv(setting, customHome);
      const provider = new ClaudeQuotaProvider({
        logger: pino({ level: "silent" }),
        homeDir,
        platform: "darwin",
        claudeHome: setting === "option" ? customHome : undefined,
        claudeKeychainReader: async () => {
          throw new Error("Default account must not be used");
        },
        fetch: async (_url, init) => {
          expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer account-b");
          return new Response(null, { status: 401 });
        },
      });
      expect((await provider.fetchUsage()).status).toBe("unavailable");
      await rm(customPath);
      expect((await provider.fetchUsage()).status).toBe("unavailable");
    },
  );

  it.each([null, {}, { claudeAiOauth: {} }])(
    "uses the file when default Keychain has no usable credential (%j)",
    async (keychain) => {
      const provider = new ClaudeQuotaProvider({
        logger: pino({ level: "silent" }),
        homeDir,
        platform: "darwin",
        claudeKeychainReader: async () => keychain,
        fetch: async (_url, init) => {
          expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer stale-file");
          return Response.json({ five_hour: { utilization: 30 } });
        },
      });
      expect((await provider.fetchUsage()).windows[0].usedPct).toBe(30);
    },
  );

  it("re-reads rotated Keychain credentials on the next fetch", async () => {
    let token = "first";
    const calls: string[] = [];
    const provider = new ClaudeQuotaProvider({
      logger: pino({ level: "silent" }),
      homeDir,
      platform: "darwin",
      claudeKeychainReader: async () => ({ claudeAiOauth: { accessToken: token } }),
      fetch: async (_url, init) => {
        calls.push(new Headers(init?.headers).get("Authorization")!);
        return Response.json({ five_hour: { utilization: 10 } });
      },
    });
    await provider.fetchUsage();
    token = "second";
    await provider.fetchUsage();
    expect(calls).toEqual(["Bearer first", "Bearer second"]);
    expect(await readFile(credentialPath, "utf8")).toBe(fileContents);
  });
});
