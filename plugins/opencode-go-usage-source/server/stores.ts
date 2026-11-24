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
export interface StorePaths {
  file: string;
  database: string;
}

/** A credential OpenCode can serve Go with. Anything else on the integration is ignored. */
export type GoCredential =
  | { type: "key"; key: string }
  | { type: "console"; access: string; expires: number; orgID: string };

/** The selected credential on each integration that can carry OpenCode Go. */
export interface DatabaseLogins {
  /** OpenCode binds Go to this integration when the Console workspace has Go. */
  opencode: GoCredential | null;
  go: GoCredential | null;
}

const CONSOLE_SERVER = "https://opencode.ai/console";
const ORGANIZATION_ID = /^(?:org|wrk)_[A-Za-z0-9]+$/;

const fileSchema = z.object({
  "opencode-go": z.object({ type: z.literal("api"), key: z.string().min(1) }).optional(),
});
const rowSchema = z.object({ value: z.string() });
const metadataSchema = z
  .object({ server: z.string().optional(), orgID: z.string().optional() })
  .optional();
const credentialSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("key"), key: z.string().min(1), metadata: metadataSchema }),
  z.object({
    type: z.literal("oauth"),
    access: z.string().min(1),
    expires: z.number(),
    metadata: metadataSchema,
  }),
]);

export function defaultStorePaths(env: NodeJS.ProcessEnv = process.env): StorePaths {
  const dataHome = env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share");
  const directory = join(dataHome, "opencode");
  const database = resolve(directory, env.OPENCODE_DB || "opencode.db");
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

/** Null when the path is not an OpenCode v2 credential store. */
export function readDatabaseLogins(path: string): DatabaseLogins | null {
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
    return { opencode: selected(db, "opencode"), go: selected(db, "opencode-go") };
  } finally {
    db.close();
  }
}

function selected(db: Database, integrationID: string): GoCredential | null {
  const [value] = db
    .prepare(
      // OpenCode also selects migrated rows with no active flag, ordered by creation time.
      "SELECT value FROM credential WHERE integration_id = ? ORDER BY active DESC, time_created DESC, id DESC LIMIT 1",
    )
    .all(integrationID);
  const row = rowSchema.safeParse(value);
  if (!row.success) return null;
  let credential: unknown;
  try {
    credential = JSON.parse(row.data.value);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const parsed = credentialSchema.safeParse(credential);
  if (!parsed.success) return null;
  const { data } = parsed;
  // A credential for another Console never goes to opencode.ai.
  if (consoleServer(data.metadata?.server) !== CONSOLE_SERVER) return null;
  if (data.type === "key") return { type: "key", key: data.key };
  const orgID = data.metadata?.orgID;
  if (integrationID !== "opencode" || !orgID || !ORGANIZATION_ID.test(orgID)) return null;
  return { type: "console", access: data.access, expires: data.expires, orgID };
}

// OpenCode defaults a missing server to the Console and maps the retired host onto it.
function consoleServer(server: string | undefined): string {
  return (server ?? CONSOLE_SERVER).replace(
    /^https:\/\/console\.opencode\.ai(?=\/|$)/,
    CONSOLE_SERVER,
  );
}
