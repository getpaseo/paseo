import { createDecipheriv, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";

/**
 * The ZCode desktop app keeps its credentials in
 * `~/.zcode/v2/credentials.json`, encrypted with AES-256-GCM. The key is
 * derived from a secret that defaults to the platform, the home directory and
 * the user name, so a Paseo usage source can read the same store the app does.
 *
 * The values are read only; nothing here writes to the store.
 */
const ENCRYPTED_VALUE_PREFIX = "enc:v1:";
const CIPHER_ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const SECRET_ENV_KEY = "ZCODE_CREDENTIAL_SECRET";

const CredentialsSchema = {
  /** The OAuth access token of the signed-in account. */
  accessTokenKey: "oauth:bigmodel:access_token",
  /** The OAuth access token of a signed-in Z.ai account. */
  zaiAccessTokenKey: "oauth:zai:access_token",
} as const;

function deriveCipherKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function defaultCredentialSecret(env: NodeJS.ProcessEnv): string {
  const configured = env[SECRET_ENV_KEY];
  if (configured) return configured;

  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // Some runtimes cannot read the system user; the placeholder keeps the
    // derivation deterministic.
  }
  return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
}

export function decryptCredential(value: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!value.startsWith(ENCRYPTED_VALUE_PREFIX)) return value;

  const parts = value.slice(ENCRYPTED_VALUE_PREFIX.length).split(".");
  const [ivRaw, authTagRaw, cipherRaw] = parts;
  if (!ivRaw || !authTagRaw || cipherRaw === undefined || parts.length !== 3) {
    throw new Error("Encrypted credential has an invalid format");
  }

  const iv = Buffer.from(ivRaw, "base64url");
  const authTag = Buffer.from(authTagRaw, "base64url");
  const cipherText = Buffer.from(cipherRaw, "base64url");
  if (iv.length !== IV_BYTES) throw new Error("Encrypted credential has an invalid IV");
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new Error("Encrypted credential has an invalid auth tag");
  }

  const key = deriveCipherKey(defaultCredentialSecret(env));
  const decipher = createDecipheriv(CIPHER_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString("utf-8");
  } catch {
    throw new Error("Encrypted credential does not match this machine's key");
  }
}

export function zcodeCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const baseDir = env.ZCODE_DATA_BASE_DIR?.trim() || homedir();
  return join(baseDir, ".zcode", "v2", "credentials.json");
}

/**
 * Reads the Coding Plan API key the ZCode app stores for the signed-in
 * account. The key is the one the account's provider entry is registered
 * with, so the quota it reports is the quota the account is billed against.
 */
export async function readZCodeApiKey(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(zcodeCredentialsPath(env), "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

  const entries = Object.entries(parsed as Record<string, string>);
  const apiKeyEntry = entries.find(([key]) => key.includes("api-key"));
  if (!apiKeyEntry) return undefined;

  try {
    const key = decryptCredential(apiKeyEntry[1], env);
    return key.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the OAuth access token of the signed-in account. It answers the same
 * quota endpoint as the API key, and it identifies the account the plan
 * belongs to.
 */
export async function readZCodeAccessToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(zcodeCredentialsPath(env), "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

  const store = parsed as Record<string, string>;
  for (const key of [CredentialsSchema.accessTokenKey, CredentialsSchema.zaiAccessTokenKey]) {
    const value = store[key];
    if (!value) continue;
    try {
      const token = decryptCredential(value, env);
      if (token.trim()) return token.trim();
    } catch {
      // Try the next credential.
    }
  }
  return undefined;
}
