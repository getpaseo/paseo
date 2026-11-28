import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export interface StoreLookup {
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  sqlite?: () => Sqlite | undefined;
}
interface Database {
  prepare(sql: string): { all(...args: string[]): unknown[] };
  close(): void;
}
export interface Sqlite {
  DatabaseSync: new (path: string, options: { readOnly: boolean }) => Database;
}

/** Login kinds in the order Kiro CLI reads them. */
export const TOKEN_KEYS = [
  "kirocli:odic:token",
  "kirocli:social:token",
  "kirocli:external-idp:token",
] as const;
const PROFILE_KEY = "api.codewhisperer.profile";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_at: z.string().optional(),
  region: z.string().optional(),
  start_url: z.string().optional(),
  profile_arn: z.string().optional(),
});
const profileSchema = z.object({ arn: z.string().min(1) });
const rowSchema = z.object({ key: z.string(), value: z.string() });

export interface KiroLogin {
  kind: (typeof TOKEN_KEYS)[number];
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  region?: string;
  startUrl?: string;
  profileArn?: string;
}

/** Kiro CLI keeps logins in `data.sqlite3` under the platform's local data directory. */
export function kiroDatabasePath(lookup: StoreLookup = {}): string {
  const home = lookup.home ?? homedir();
  const env = lookup.env ?? process.env;
  const platform = lookup.platform ?? process.platform;
  let dataDir: string;
  if (platform === "darwin") dataDir = join(home, "Library", "Application Support");
  else if (platform === "win32") dataDir = env.LOCALAPPDATA || join(home, "AppData", "Local");
  else dataDir = env.XDG_DATA_HOME || join(home, ".local", "share");
  return join(dataDir, "kiro-cli", "data.sqlite3");
}

function builtinSqlite(): Sqlite | undefined {
  // Node 20 must still load the plugin; `node:sqlite` only exists on newer runtimes.
  const parsed = z
    .object({
      DatabaseSync: z.custom<Sqlite["DatabaseSync"]>((value) => typeof value === "function"),
    })
    .safeParse(process.getBuiltinModule?.("node:sqlite"));
  return parsed.success ? parsed.data : undefined;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function rows(db: Database, table: string, keys: readonly string[]): Map<string, string> {
  const placeholders = keys.map(() => "?").join(", ");
  const result = new Map<string, string>();
  for (const value of db
    .prepare(`SELECT key, value FROM ${table} WHERE key IN (${placeholders})`)
    .all(...keys)) {
    const row = rowSchema.safeParse(value);
    if (row.success) result.set(row.data.key, row.data.value);
  }
  return result;
}

/** Reads the active Kiro CLI login without refreshing or writing it. */
export function readKiroLogin(path: string, lookup: StoreLookup = {}): KiroLogin | null {
  const sqlite = (lookup.sqlite ?? builtinSqlite)();
  if (!sqlite || !existsSync(path)) return null;
  let db: Database | undefined;
  try {
    db = new sqlite.DatabaseSync(path, { readOnly: true });
    const tokens = rows(db, "auth_kv", TOKEN_KEYS);
    const kind = TOKEN_KEYS.find((key) => tokens.has(key));
    if (!kind) return null;
    const token = tokenSchema.safeParse(parseJson(tokens.get(kind)!));
    if (!token.success) return null;
    const profile = profileSchema.safeParse(
      parseJson(rows(db, "state", [PROFILE_KEY]).get(PROFILE_KEY) ?? ""),
    );
    const expiresAt = token.data.expires_at ? Date.parse(token.data.expires_at) : Number.NaN;
    const profileArn = token.data.profile_arn ?? (profile.success ? profile.data.arn : undefined);
    return {
      kind,
      accessToken: token.data.access_token,
      ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
      ...(token.data.region ? { region: token.data.region } : {}),
      ...(token.data.start_url ? { startUrl: token.data.start_url } : {}),
      ...(profileArn ? { profileArn } : {}),
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
