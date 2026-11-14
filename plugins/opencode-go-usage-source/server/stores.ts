import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

interface Database {
  prepare(sql: string): { all(...args: string[]): unknown[] };
  close(): void;
}
interface Sqlite {
  DatabaseSync: new (path: string, options: { readOnly: boolean }) => Database;
}
interface DatabaseLogin {
  key: string | null;
}
export interface StorePaths {
  file: string;
  database: string;
}

const fileSchema = z.object({
  "opencode-go": z.object({ type: z.literal("api"), key: z.string().min(1) }).optional(),
});
const rowSchema = z.object({ value: z.string() });
const keySchema = z.object({ type: z.literal("key"), key: z.string().min(1) });

export function defaultStorePaths(env: NodeJS.ProcessEnv = process.env): StorePaths {
  const dataHome = env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share");
  const directory = join(dataHome, "opencode");
  const database = env.OPENCODE_DB ? resolve(env.OPENCODE_DB) : join(directory, "opencode.db");
  return { file: join(directory, "auth.json"), database };
}

export async function readFileKey(path: string): Promise<string | null> {
  try {
    const auth = fileSchema.parse(JSON.parse(await readFile(path, "utf8")));
    return auth["opencode-go"]?.key ?? null;
  } catch {
    return null;
  }
}

export function readDatabaseLogin(path: string): DatabaseLogin | null {
  // Keep the legacy source loadable on Node versions without node:sqlite.
  const sqlite = z
    .object({
      DatabaseSync: z.custom<Sqlite["DatabaseSync"]>((value) => typeof value === "function"),
    })
    .safeParse(process.getBuiltinModule?.("node:sqlite"));
  if (!sqlite.success || !existsSync(path)) return null;
  const db = new sqlite.data.DatabaseSync(path, { readOnly: true });
  try {
    // V1 also has opencode.db, but only v2 has the credential table.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credential'")
      .all();
    if (!tables.length) return null;
    const [value] = db
      .prepare(
        "SELECT value FROM credential WHERE integration_id = ? AND active = 1 ORDER BY time_updated DESC, id DESC LIMIT 1",
      )
      .all("opencode-go");
    const row = rowSchema.safeParse(value);
    if (!row.success) return { key: null };
    let credential: unknown;
    try {
      credential = JSON.parse(row.data.value);
    } catch (error) {
      if (error instanceof SyntaxError) return { key: null };
      throw error;
    }
    const parsed = keySchema.safeParse(credential);
    return { key: parsed.success ? parsed.data.key : null };
  } finally {
    db.close();
  }
}
