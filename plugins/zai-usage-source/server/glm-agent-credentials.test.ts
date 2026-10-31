import { createCipheriv, createHash as createSha256, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import { injectGlmApiKey, Z_AI_API_KEY_ENV } from "./glm-agent-credentials.js";

/**
 * The ZCode desktop app encrypts its credentials with a key derived from the
 * machine, so the fixture encrypts the API key the same way the app does.
 */
function encryptCredential(value: string, secret: string): string {
  const iv = randomBytes(12);
  const key = createCipheriv("aes-256-gcm", createSha256("sha256").update(secret).digest(), iv);
  const cipherText = Buffer.concat([key.update(value, "utf8"), key.final()]);
  const authTag = key.getAuthTag();
  return `enc:v1:${iv.toString("base64url")}.${authTag.toString(
    "base64url",
  )}.${cipherText.toString("base64url")}`;
}

describe("GLM ACP agent credentials", () => {
  let homeDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "glm-credentials-"));
    originalEnv = { ...process.env };
    process.env["HOME"] = homeDir;
    process.env["USERPROFILE"] = homeDir;
    process.env["ZCODE_DATA_BASE_DIR"] = homeDir;
    delete process.env["ZCODE_CREDENTIAL_SECRET"];
    delete process.env[Z_AI_API_KEY_ENV];
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    for (const key in originalEnv) process.env[key] = originalEnv[key];
  });

  function writeZCodeCredentials(apiKey: string): void {
    const dir = join(homeDir, ".zcode", "v2");
    mkdirSync(dir, { recursive: true });
    // The key derivation uses the real home directory and user name, not the
    // directory the store is redirected to.
    const secret = `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
    writeFileSync(
      join(dir, "credentials.json"),
      JSON.stringify({
        "account-provider:coding-plan:account:bigmodel-team-coding-plan:api-key": encryptCredential(
          apiKey,
          secret,
        ),
      }),
    );
  }

  function agentConfig(provider: string): AgentSessionConfig {
    return { provider, cwd: "/repo" };
  }

  it("adds the ZCode Coding Plan key to a GLM ACP agent that has none", async () => {
    writeZCodeCredentials("zai_signing_in_key");

    const request = await injectGlmApiKey({ config: agentConfig("glm-acp-agent") });

    expect(request.env?.[Z_AI_API_KEY_ENV]).toBe("zai_signing_in_key");
  });

  it("keeps a key the user configured themselves", async () => {
    writeZCodeCredentials("zai_signing_in_key");

    const request = await injectGlmApiKey({
      config: agentConfig("glm-acp-agent"),
      env: { [Z_AI_API_KEY_ENV]: "user_supplied_key" },
    });

    expect(request.env?.[Z_AI_API_KEY_ENV]).toBe("user_supplied_key");
  });

  it("leaves other providers alone", async () => {
    writeZCodeCredentials("zai_signing_in_key");

    const request = await injectGlmApiKey({ config: agentConfig("claude") });

    expect(request.env?.[Z_AI_API_KEY_ENV]).toBeUndefined();
  });

  it("leaves the environment untouched when the account is not signed in", async () => {
    const request = await injectGlmApiKey({ config: agentConfig("glm-acp-agent") });

    expect(request.env?.[Z_AI_API_KEY_ENV]).toBeUndefined();
  });
});
