// POSIX-only: file mode bits are not represented the same way on Windows.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isPlatform } from "../../../../test-utils/platform.js";
import { loginAndStoreOAuth, storeOAuthCredential } from "./oauth-store.js";

describe.skipIf(isPlatform("win32"))("oauth-store POSIX-only", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "paseo-oauth-store-"));
    env = { PASEO_HOME: home };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("stores login credentials in a private file", async () => {
    const login = async () => ({ refresh: "rt-from-login", access: "ac", expires: 123 });

    const { path } = await loginAndStoreOAuth({
      flow: "paseo-test-oauth",
      baseUrl: "https://api.example.test/oauth",
      providerInstance: "chatgpt",
      env,
      onDeviceCode: () => {},
      login,
    });

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("stores explicit credentials in a private file", () => {
    const { path } = storeOAuthCredential({
      providerInstance: "chatgpt",
      env,
      binding: { flow: "paseo-test-oauth", baseUrl: "https://api.example.test/oauth" },
      credential: { type: "oauth", access: "ac", refresh: "rt", expires: 123 },
    });

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
