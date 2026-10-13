import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AntigravityUsageInput } from "../shared/input.js";
import { hashAccountKey, type UsageAccount, type UsageScope } from "@getpaseo/plugin/server/usage";

export interface StoreLookup {
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => number;
}

export interface Auth {
  token: string;
  tokenType?: string;
  expires?: number;
  idToken?: string;
}

const authFileSchema = z.object({
  token: z
    .object({
      access_token: z.string().optional(),
      token_type: z.string().optional(),
      expiry: z.union([z.string(), z.number()]).optional(),
      expiry_date: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
  access_token: z.string().optional(),
  token_type: z.string().optional(),
  expiry: z.union([z.string(), z.number()]).optional(),
  expiry_date: z.union([z.string(), z.number()]).optional(),
  id_token: z.string().optional(),
  idToken: z.string().optional(),
});

export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function parseExpiry(rawExpiry: string | number | undefined): number | undefined {
  if (typeof rawExpiry === "number") return rawExpiry;
  if (typeof rawExpiry === "string") {
    const parsedTime = Date.parse(rawExpiry);
    if (!Number.isNaN(parsedTime)) return parsedTime;
  }
  return undefined;
}

export async function readAuth(
  input: AntigravityUsageInput,
  _lookup: StoreLookup = {},
): Promise<Auth | null> {
  const route = input.route;
  if (route.store !== "antigravity") return null;

  const raw = await readJson(route.path);
  const parsed = authFileSchema.safeParse(raw);
  if (!parsed.success) return null;

  const data = parsed.data;
  const token = data.token?.access_token ?? data.access_token;
  if (!token) return null;

  const tokenType = data.token?.token_type ?? data.token_type;
  const rawExpiry =
    data.token?.expiry ?? data.token?.expiry_date ?? data.expiry ?? data.expiry_date;
  const expires = parseExpiry(rawExpiry);
  const idToken = data.id_token ?? data.idToken;

  return {
    token,
    ...(tokenType ? { tokenType } : {}),
    ...(expires !== undefined ? { expires } : {}),
    ...(idToken ? { idToken } : {}),
  };
}

function globalRoutes(lookup: StoreLookup): AntigravityUsageInput[] {
  const env = lookup.env ?? process.env;
  const home = lookup.home ?? homedir();

  const geminiHome = env.GEMINI_HOME?.trim();
  const candidates: string[] = [
    ...(geminiHome ? [join(geminiHome, "antigravity-cli", "antigravity-oauth-token")] : []),
    ...(geminiHome ? [join(geminiHome, "oauth_creds.json")] : []),
    join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    join(home, ".gemini", "oauth_creds.json"),
  ];

  return [...new Set(candidates)]
    .filter((path) => existsSync(path))
    .map((path) => ({
      route: { store: "antigravity", path },
    }));
}

function sessionRoutes(
  scope: Extract<UsageScope, { kind: "session" }>,
  lookup: StoreLookup,
): AntigravityUsageInput[] {
  if (scope.provider !== "antigravity") return [];

  const env = scope.env;
  const home = env.HOME || env.USERPROFILE || lookup.home || homedir();
  const geminiHome = env.GEMINI_HOME?.trim();

  const candidates: string[] = [
    ...(geminiHome ? [join(geminiHome, "antigravity-cli", "antigravity-oauth-token")] : []),
    ...(geminiHome ? [join(geminiHome, "oauth_creds.json")] : []),
    join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    join(home, ".gemini", "oauth_creds.json"),
  ];

  return [...new Set(candidates)]
    .filter((path) => existsSync(path))
    .map((path) => ({
      route: { store: "antigravity", path },
    }));
}

export async function discover(
  scope: UsageScope,
  lookup: StoreLookup = {},
): Promise<UsageAccount[]> {
  if (scope.kind === "session") {
    lookup = {
      ...lookup,
      env: scope.env,
      home: scope.env.HOME || scope.env.USERPROFILE || lookup.home || homedir(),
    };
  }

  const candidates = scope.kind === "global" ? globalRoutes(lookup) : sessionRoutes(scope, lookup);

  const present: UsageAccount[] = [];
  for (const input of candidates) {
    const auth = await readAuth(input, lookup);
    if (auth) {
      const identity = accountIdentity(auth, input);
      present.push({
        ...identity,
        harness: "Antigravity",
        input,
      });
    }
  }
  return present;
}

function jwtClaims(token: string | undefined): Record<string, unknown> | null {
  try {
    const payload = token?.split(".")[1];
    return payload
      ? (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function extractEmail(claims: Record<string, unknown> | null): string | undefined {
  if (typeof claims?.email === "string" && claims.email.length > 0) {
    return claims.email;
  }
  if (typeof claims?.upn === "string" && claims.upn.length > 0) {
    return claims.upn;
  }
  return undefined;
}

export function accountIdentity(
  auth: Auth,
  input: AntigravityUsageInput,
): { key: string; label?: string } {
  const claims = jwtClaims(auth.idToken);
  const email = extractEmail(claims);

  const base = email ?? JSON.stringify(input.route);
  return {
    key: hashAccountKey(base),
    ...(email ? { label: email } : {}),
  };
}
