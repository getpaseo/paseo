import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials, OAuthProviderInterface } from "@earendil-works/pi-ai";
import { registerOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createBoundPaseoAgentAuthStorage,
  getStoredOAuthCredentialState,
  hasStoredOAuthCredential,
  loginAndStoreOAuth,
  loginOAuthBrowser,
  paseoAgentAuthStoragePath,
  storeOAuthCredential,
} from "./oauth-store.js";

const TEST_FLOW = "paseo-test-oauth-store";
const TEST_BASE_URL = "https://api.example.test/oauth";

function registerTestOAuthProvider(): void {
  const provider: OAuthProviderInterface = {
    id: TEST_FLOW,
    name: "Paseo Test OAuth",
    async login(callbacks): Promise<OAuthCredentials> {
      callbacks.onDeviceCode({
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.example.test/device",
        intervalSeconds: 5,
        expiresInSeconds: 900,
      });
      return { refresh: "rt-from-registry", access: "ac", expires: 123, accountId: "acct" };
    },
    async refreshToken(credentials): Promise<OAuthCredentials> {
      return credentials;
    },
    getApiKey(credentials): string {
      return credentials.access;
    },
  };
  registerOAuthProvider(provider);
}

describe("oauth-store", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "paseo-oauth-store-"));
    env = { PASEO_HOME: home };
  });
  afterEach(() => {
    resetOAuthProviders();
    rmSync(home, { recursive: true, force: true });
  });

  it("derives the store path from PASEO_HOME", () => {
    expect(paseoAgentAuthStoragePath(env)).toBe(join(home, "paseo-agent", "auth.json"));
  });

  it("reports no stored credential before login", () => {
    expect(hasStoredOAuthCredential("chatgpt", env)).toBe(false);
  });

  it("stores a protocol credential with future fields intact", () => {
    const { path } = storeOAuthCredential({
      providerInstance: "chatgpt",
      env,
      binding: { flow: TEST_FLOW, baseUrl: TEST_BASE_URL },
      credential: {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: 123,
        futureField: { keep: true },
      },
    });

    expect(hasStoredOAuthCredential("chatgpt", env)).toBe(true);
    expect(
      hasStoredOAuthCredential("chatgpt", env, { flow: TEST_FLOW, baseUrl: TEST_BASE_URL }),
    ).toBe(true);
    expect(
      getStoredOAuthCredentialState("chatgpt", env, {
        flow: TEST_FLOW,
        baseUrl: "https://api.example.test/changed",
      }),
    ).toEqual({ present: true, bindingMatches: false });
    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored.chatgpt).toMatchObject({
      type: "oauth",
      refresh: "refresh-token",
      binding: { flow: TEST_FLOW, baseUrl: TEST_BASE_URL },
      futureField: { keep: true },
    });
  });

  it("hides mismatched credentials from runtime auth storage without deleting them", async () => {
    const { path } = storeOAuthCredential({
      providerInstance: "chatgpt",
      env,
      binding: { flow: TEST_FLOW, baseUrl: TEST_BASE_URL },
      credential: {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: 123,
      },
    });

    const authStorage = createBoundPaseoAgentAuthStorage(
      {
        chatgpt: { flow: TEST_FLOW, baseUrl: "https://api.example.test/changed" },
      },
      env,
    );

    expect(authStorage.has("chatgpt")).toBe(false);
    await expect(authStorage.getApiKey("chatgpt", { includeFallback: false })).resolves.toBe(
      undefined,
    );
    expect(JSON.parse(readFileSync(path, "utf8")).chatgpt).toMatchObject({
      type: "oauth",
      refresh: "refresh-token",
      binding: { flow: TEST_FLOW, baseUrl: TEST_BASE_URL },
    });
  });

  it("runs the Pi registry login flow and persists a Paseo-owned credential", async () => {
    registerTestOAuthProvider();
    const deviceCodes: unknown[] = [];

    const { path } = await loginAndStoreOAuth({
      flow: TEST_FLOW,
      baseUrl: TEST_BASE_URL,
      providerInstance: "chatgpt",
      env,
      onDeviceCode: (info) => deviceCodes.push(info),
    });

    expect(deviceCodes).toEqual([expect.objectContaining({ userCode: "ABCD-EFGH" })]);
    expect(path).toBe(join(home, "paseo-agent", "auth.json"));
    expect(hasStoredOAuthCredential("chatgpt", env)).toBe(true);
    const stored = JSON.parse(readFileSync(path, "utf8"));
    expect(stored.chatgpt).toMatchObject({ type: "oauth", refresh: "rt-from-registry" });
  });

  it("keys the credential by provider instance name", async () => {
    const login = async () => ({ refresh: "rt", access: "", expires: 0 });
    await loginAndStoreOAuth({
      flow: TEST_FLOW,
      baseUrl: TEST_BASE_URL,
      providerInstance: "work-chatgpt",
      env,
      onDeviceCode: () => {},
      login,
    });
    expect(hasStoredOAuthCredential("work-chatgpt", env)).toBe(true);
    expect(hasStoredOAuthCredential("chatgpt", env)).toBe(false);
  });

  it("browser login surfaces the auth URL and returns a credential without storing it", async () => {
    const authUrls: Array<[string, string | undefined]> = [];
    const loginCalls: string[] = [];
    const login = async (opts: { onAuth: (info: { url: string }) => void }) => {
      loginCalls.push("called");
      opts.onAuth({ url: "https://auth.example.test/oauth/authorize?x=1" });
      return { refresh: "rt-browser", access: "ac", expires: 456, accountId: "acct" };
    };

    const credential = await loginOAuthBrowser({
      flow: TEST_FLOW,
      onAuthUrl: (url, instructions) => authUrls.push([url, instructions]),
      login,
    });

    expect(loginCalls).toEqual(["called"]);
    expect(authUrls).toEqual([["https://auth.example.test/oauth/authorize?x=1", undefined]]);
    expect(credential).toMatchObject({ type: "oauth", refresh: "rt-browser" });
    expect(hasStoredOAuthCredential("chatgpt", env)).toBe(false);
  });

  it("browser login falls back to manual code entry only when the callback can't complete", async () => {
    const prompts: string[] = [];
    const promptForCode = async (message: string) => {
      prompts.push(message);
      return "pasted-code";
    };
    const login = async (opts: { onPrompt: (p: { message: string }) => Promise<string> }) => {
      const code = await opts.onPrompt({ message: "Paste the code:" });
      expect(code).toBe("pasted-code");
      return { refresh: "rt-manual", access: "", expires: 0 };
    };

    const credential = await loginOAuthBrowser({
      flow: TEST_FLOW,
      onAuthUrl: () => {},
      promptForCode,
      login,
    });

    expect(prompts).toEqual(["Paste the code:"]);
    expect(credential).toMatchObject({ type: "oauth", refresh: "rt-manual" });
  });
});
