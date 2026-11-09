import { execFile } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { KeyStore, LoginInput } from "../shared/input.js";

const execFileAsync = promisify(execFile);
const SECRET_TIMEOUT_MS = 2_000;
const KEY_BYTES = 32;
const IV_BYTES = 16;
const TAG_BYTES = 16;

// Store layout verified against the Droid CLI 0.249.0 bundle: the login JSON is AES-256-GCM
// encrypted as base64 `iv:tag:ciphertext`. Its 32-byte key is base64 in the OS secret store
// (keytar on Linux, the `security` CLI on macOS) or in auth.v2.key next to auth.v2.file.
const SECRET_SERVICE = "Factory CLI";
const KEYRING_ACCOUNT = "auth-encryption-key";
const KEYCHAIN_ACCOUNT = "auth-encryption-key-security-cli";
const CREDENTIAL_FILES: Record<KeyStore, string> = {
  keyring: "auth.v2.keyring",
  keychain: "auth.v2.loginkeychain",
  file: "auth.v2.file",
};
const KEY_FILE = "auth.v2.key";

const whoamiSchema = z
  .object({ region: z.string().nullish(), isOnPrem: z.boolean().nullish() })
  .passthrough();
const credentialsSchema = z
  .object({
    access_token: z.string().min(1),
    active_organization_id: z.string().nullish(),
    whoami: whoamiSchema.nullish().catch(null),
    region: z.string().nullish().catch(null),
  })
  .passthrough();
const tokenClaimsSchema = z
  .object({ sub: z.string().optional(), org_id: z.string().optional(), exp: z.number().optional() })
  .passthrough();

export interface FactoryCredentials {
  accessToken: string;
  organizationId: string | null;
  region: string | null;
  isOnPrem: boolean;
}

export interface TokenClaims {
  subject: string | null;
  organizationId: string | null;
  expiresAt: number | null;
}

export type SecretReader = (store: Exclude<KeyStore, "file">) => Promise<string | null>;

export interface StoreLookup {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readSecret?: SecretReader;
}

export function factoryDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.FACTORY_HOME_OVERRIDE || env.HOME || env.USERPROFILE || homedir(), ".factory");
}

/** Stores in the order the CLI loads them: the OS secret store first, then the key file. */
export function keyStores(platform: NodeJS.Platform): KeyStore[] {
  if (platform === "darwin") return ["keychain", "file"];
  if (platform === "linux") return ["keyring", "file"];
  // Windows keytar entries live in Credential Manager, which needs a native module to read.
  return ["file"];
}

async function runSecretCommand(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: SECRET_TIMEOUT_MS });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export const readSystemSecret: SecretReader = (store) =>
  store === "keychain"
    ? runSecretCommand("security", [
        "find-generic-password",
        "-s",
        SECRET_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
        "-w",
      ])
    : runSecretCommand("secret-tool", [
        "lookup",
        "service",
        SECRET_SERVICE,
        "account",
        KEYRING_ACCOUNT,
      ]);

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function decodeKey(value: string | null): Buffer | null {
  if (!value) return null;
  const key = Buffer.from(value.trim(), "base64");
  return key.length === KEY_BYTES ? key : null;
}

export function decryptCredentials(blob: string, key: Buffer): string {
  const parts = blob.trim().split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted Factory login format");
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, "base64")) as [
    Buffer,
    Buffer,
    Buffer,
  ];
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES)
    throw new Error("Invalid Factory login IV or auth tag length");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export async function readLogin(
  input: LoginInput,
  lookup: StoreLookup = {},
): Promise<FactoryCredentials | null> {
  const blob = await readText(join(input.factoryDir, CREDENTIAL_FILES[input.keyStore]));
  if (!blob) return null;
  const key = decodeKey(
    input.keyStore === "file"
      ? await readText(join(input.factoryDir, KEY_FILE))
      : await (lookup.readSecret ?? readSystemSecret)(input.keyStore),
  );
  if (!key) return null;
  try {
    const parsed = credentialsSchema.safeParse(JSON.parse(decryptCredentials(blob, key)));
    if (!parsed.success) return null;
    const credentials = parsed.data;
    return {
      accessToken: credentials.access_token,
      organizationId: credentials.active_organization_id ?? null,
      region: credentials.whoami?.region ?? credentials.region ?? null,
      isOnPrem: credentials.whoami?.isOnPrem === true,
    };
  } catch {
    return null;
  }
}

/** Reads unverified JWT claims; the API is the authority on whether the token is valid. */
export function tokenClaims(token: string): TokenClaims {
  const payload = token.split(".")[1];
  if (!payload) return { subject: null, organizationId: null, expiresAt: null };
  try {
    const claims = tokenClaimsSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    return {
      subject: claims.sub ?? null,
      organizationId: claims.org_id ?? null,
      expiresAt: claims.exp ?? null,
    };
  } catch {
    return { subject: null, organizationId: null, expiresAt: null };
  }
}
