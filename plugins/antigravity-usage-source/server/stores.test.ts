import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discover, readAuth, accountIdentity } from "./stores.js";
import type { AntigravityUsageInput } from "../shared/input.js";

describe("antigravity stores", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "agy-usage-home-"));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  it("discovers global CLI token path when file exists", async () => {
    const tokenDir = join(tempHome, ".gemini", "antigravity-cli");
    await mkdir(tokenDir, { recursive: true });
    await writeFile(
      join(tokenDir, "antigravity-oauth-token"),
      JSON.stringify({
        token: {
          access_token: "ya29.test-access",
          expiry: "2026-10-13T15:00:00Z",
        },
        id_token: `header.${Buffer.from(JSON.stringify({ email: "user@example.com" })).toString("base64url")}.sig`,
      }),
    );

    const accounts = await discover({ kind: "global" }, { home: tempHome, env: {} });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      label: "user@example.com",
      harness: "Antigravity",
      input: {
        route: {
          store: "antigravity",
          path: join(tokenDir, "antigravity-oauth-token"),
        },
      },
    });
  });

  it("resolves session scope for antigravity provider using session env", async () => {
    const customHome = join(tempHome, "custom-gemini");
    const tokenDir = join(customHome, "antigravity-cli");
    await mkdir(tokenDir, { recursive: true });
    await writeFile(
      join(tokenDir, "antigravity-oauth-token"),
      JSON.stringify({
        token: { access_token: "session-token" },
      }),
    );

    const accounts = await discover(
      {
        kind: "session",
        provider: "antigravity",
        env: { GEMINI_HOME: customHome },
      },
      { home: tempHome },
    );

    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.input.route.path).toBe(join(tokenDir, "antigravity-oauth-token"));
  });

  it("ignores session scope for non-antigravity providers", async () => {
    const accounts = await discover(
      {
        kind: "session",
        provider: "codex",
        env: {},
      },
      { home: tempHome },
    );
    expect(accounts).toEqual([]);
  });

  it("reads auth token, expiration, and extracts email from JWT id_token", async () => {
    const tokenPath = join(tempHome, "token.json");
    const fakeIdToken = `header.${Buffer.from(JSON.stringify({ email: "coder@google.com" })).toString("base64url")}.sig`;
    await writeFile(
      tokenPath,
      JSON.stringify({
        token: {
          access_token: "test-access-token",
          expiry: "2026-10-13T16:00:00Z",
        },
        id_token: fakeIdToken,
      }),
    );

    const auth = await readAuth({ route: { store: "antigravity", path: tokenPath } });
    expect(auth).not.toBeNull();
    expect(auth?.token).toBe("test-access-token");
    expect(auth?.idToken).toBe(fakeIdToken);
    expect(auth?.expires).toBe(new Date("2026-10-13T16:00:00Z").getTime());

    const identity = accountIdentity(auth!, { route: { store: "antigravity", path: tokenPath } });
    expect(identity.label).toBe("coder@google.com");
    expect(identity.key).toBeDefined();
  });

  it("reads numeric expiry_date from google-auth-library oauth_creds.json format", async () => {
    const credsPath = join(tempHome, "oauth_creds.json");
    const fakeExpiryMs = 1791888000000;
    await writeFile(
      credsPath,
      JSON.stringify({
        access_token: "google-auth-token",
        expiry_date: fakeExpiryMs,
      }),
    );

    const auth = await readAuth({ route: { store: "antigravity", path: credsPath } });
    expect(auth).not.toBeNull();
    expect(auth?.token).toBe("google-auth-token");
    expect(auth?.expires).toBe(fakeExpiryMs);
  });

  it("preserves alternate login inputs with the same account key when multiple token files share the same email", async () => {
    const cliDir = join(tempHome, ".gemini", "antigravity-cli");
    const rootGemini = join(tempHome, ".gemini");
    await mkdir(cliDir, { recursive: true });

    const fakeIdToken = `header.${Buffer.from(JSON.stringify({ email: "shared@google.com" })).toString("base64url")}.sig`;

    await writeFile(
      join(cliDir, "antigravity-oauth-token"),
      JSON.stringify({
        token: { access_token: "cli-token" },
        id_token: fakeIdToken,
      }),
    );
    await writeFile(
      join(rootGemini, "oauth_creds.json"),
      JSON.stringify({
        access_token: "legacy-token",
        id_token: fakeIdToken,
      }),
    );

    const accounts = await discover({ kind: "global" }, { home: tempHome, env: {} });
    expect(accounts).toHaveLength(2);
    expect(accounts[0]?.key).toBe(accounts[1]?.key);
    expect(accounts[0]?.label).toBe("shared@google.com");
    expect(accounts[1]?.label).toBe("shared@google.com");
    expect(accounts.map((a) => (a.input as AntigravityUsageInput).route.store === "antigravity" ? (a.input as AntigravityUsageInput).route.path : "")).toEqual([
      join(cliDir, "antigravity-oauth-token"),
      join(rootGemini, "oauth_creds.json"),
    ]);
  });

  it("reads credentials from macOS Keychain with go-keyring-base64: prefix", async () => {
    const fakeIdToken = `header.${Buffer.from(JSON.stringify({ email: "mac@example.com" })).toString("base64url")}.sig`;
    const payload = JSON.stringify({
      token: {
        access_token: "keychain-live-token",
        expiry: "2026-10-14T20:00:00Z",
      },
      id_token: fakeIdToken,
    });
    const keychainSecret = `go-keyring-base64:${Buffer.from(payload, "utf8").toString("base64")}`;

    const readKeychainSecret = vi.fn(async () => keychainSecret);
    const auth = await readAuth(
      { route: { store: "keychain", service: "gemini", account: "antigravity" } },
      { platform: "darwin", readKeychainSecret },
    );

    expect(readKeychainSecret).toHaveBeenCalledWith("gemini", "antigravity");
    expect(auth).not.toBeNull();
    expect(auth?.token).toBe("keychain-live-token");
    expect(auth?.idToken).toBe(fakeIdToken);
    expect(auth?.expires).toBe(new Date("2026-10-14T20:00:00Z").getTime());
  });

  it("does not query Keychain on non-darwin platforms", async () => {
    const readKeychainSecret = vi.fn(async () => "secret");
    const auth = await readAuth(
      { route: { store: "keychain" } },
      { platform: "linux", readKeychainSecret },
    );
    expect(readKeychainSecret).not.toHaveBeenCalled();
    expect(auth).toBeNull();
  });

  it("discovers Keychain account on darwin and skips matching stale file store", async () => {
    const cliDir = join(tempHome, ".gemini", "antigravity-cli");
    await mkdir(cliDir, { recursive: true });
    const fakeIdToken = `header.${Buffer.from(JSON.stringify({ email: "mac@example.com" })).toString("base64url")}.sig`;

    await writeFile(
      join(cliDir, "antigravity-oauth-token"),
      JSON.stringify({
        token: { access_token: "stale-file-token", expiry: "2026-10-10T10:00:00Z" },
        id_token: fakeIdToken,
      }),
    );

    const payload = JSON.stringify({
      token: { access_token: "live-keychain-token", expiry: "2026-10-14T20:00:00Z" },
      id_token: fakeIdToken,
    });
    const keychainSecret = `go-keyring-base64:${Buffer.from(payload, "utf8").toString("base64")}`;
    const readKeychainSecret = vi.fn(async () => keychainSecret);

    const accounts = await discover(
      { kind: "global" },
      { home: tempHome, platform: "darwin", env: {}, readKeychainSecret },
    );

    expect(readKeychainSecret).toHaveBeenCalled();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.input.route.store).toBe("keychain");
    expect(accounts[0]?.label).toBe("mac@example.com");
  });

  it("falls back to file accounts when Keychain has no credentials on darwin", async () => {
    const cliDir = join(tempHome, ".gemini", "antigravity-cli");
    await mkdir(cliDir, { recursive: true });
    const fakeIdToken = `header.${Buffer.from(JSON.stringify({ email: "fallback@example.com" })).toString("base64url")}.sig`;

    await writeFile(
      join(cliDir, "antigravity-oauth-token"),
      JSON.stringify({
        token: { access_token: "file-token" },
        id_token: fakeIdToken,
      }),
    );

    const accounts = await discover(
      { kind: "global" },
      {
        home: tempHome,
        platform: "darwin",
        env: {},
        readKeychainSecret: async () => null,
      },
    );

    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.input.route.store).toBe("antigravity");
    expect(accounts[0]?.label).toBe("fallback@example.com");
  });
});
