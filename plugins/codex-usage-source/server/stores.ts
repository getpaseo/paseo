import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { routeSchema } from "../shared/input.js";

export interface StoreLookup {
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => number;
  sqlite?: () => Sqlite | undefined;
}
interface Database {
  prepare(sql: string): { all(...args: string[]): unknown[] };
  close(): void;
}
export interface Sqlite {
  DatabaseSync: new (path: string, options: { readOnly: boolean }) => Database;
}
export const oauthSchema = z.object({
  access: z.string().min(1),
  accountId: z.string().optional(),
  expires: z.number().optional(),
});
const rowSchema = z.object({ id: z.number().int().positive(), data: z.string() });
export type Route = z.infer<typeof routeSchema>;

export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export function piAuthPath(lookup: StoreLookup): string {
  const home = lookup.home ?? homedir();
  const env = lookup.env ?? process.env;
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(home, ".pi", "agent", "auth.json");
  if (configured === "~") return join(home, "auth.json");
  const directory = configured.startsWith("~/")
    ? join(home, configured.slice(2))
    : resolve(configured);
  return join(directory, "auth.json");
}

function ompDatabasePath(lookup: StoreLookup): string {
  const home = lookup.home ?? homedir();
  const env = lookup.env ?? process.env;
  const platform = lookup.platform ?? process.platform;
  const profile = (env.OMP_PROFILE ?? env.PI_PROFILE)?.trim() || "default";
  const base = join(home, env.PI_CONFIG_DIR || ".omp");
  const configRoot = profile === "default" ? base : join(base, "profiles", profile);
  const defaultAgentDir = join(configRoot, "agent");
  const agentDir =
    profile === "default" && env.PI_CODING_AGENT_DIR
      ? resolve(env.PI_CODING_AGENT_DIR)
      : defaultAgentDir;
  if (
    (platform === "linux" || platform === "darwin") &&
    agentDir === defaultAgentDir &&
    env.XDG_DATA_HOME
  ) {
    const xdgBase = join(env.XDG_DATA_HOME, "omp");
    const xdgRoot = profile === "default" ? xdgBase : join(xdgBase, "profiles", profile);
    if (existsSync(xdgRoot)) return join(xdgRoot, "agent.db");
  }
  return join(agentDir, "agent.db");
}

function builtinSqlite(): Sqlite | undefined {
  // Node 20 must still compile/load the plugin; only OMP needs this newer builtin.
  const parsed = z
    .object({
      DatabaseSync: z.custom<Sqlite["DatabaseSync"]>((value) => typeof value === "function"),
    })
    .safeParse(process.getBuiltinModule?.("node:sqlite"));
  return parsed.success ? parsed.data : undefined;
}

function ompRows(path: string, lookup: StoreLookup) {
  let db: Database | undefined;
  try {
    const sqlite = (lookup.sqlite ?? builtinSqlite)();
    if (!sqlite) return [];
    db = new sqlite.DatabaseSync(path, { readOnly: true });
    const rows = db
      .prepare(
        "SELECT id, data FROM auth_credentials WHERE provider = ? AND credential_type = 'oauth' AND disabled_cause IS NULL ORDER BY id",
      )
      .all("openai-codex");
    return rows.flatMap((value) => {
      const row = rowSchema.safeParse(value);
      if (!row.success) return [];
      try {
        const oauth = oauthSchema.parse(JSON.parse(row.data.data));
        if (oauth.expires === undefined || oauth.expires <= (lookup.now ?? Date.now)()) return [];
        return [{ id: row.data.id, oauth }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

export function discoverOmp(lookup: StoreLookup): Route[] {
  const path = ompDatabasePath(lookup);
  return ompRows(path, lookup).map(({ id }) => ({ store: "omp", path, credentialId: id }));
}

export function readOmp(route: Extract<Route, { store: "omp" }>, lookup: StoreLookup) {
  return ompRows(route.path, lookup).find((row) => row.id === route.credentialId)?.oauth ?? null;
}

export async function readHarness(
  route: Extract<Route, { path: string }>,
  lookup: StoreLookup = {},
) {
  if (route.store === "omp") return readOmp(route, lookup);
  const provider = route.store === "opencode" ? "openai" : "openai-codex";
  const parsed = z.record(z.string(), z.unknown()).safeParse(await readJson(route.path));
  if (!parsed.success) return null;
  const oauth = oauthSchema.extend({ type: z.literal("oauth") }).safeParse(parsed.data[provider]);
  return oauth.success ? oauth.data : null;
}
