import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

interface ConversationDb {
  prepare(sql: string): {
    get(...params: number[]): Record<string, unknown> | undefined;
    iterate(...params: number[]): Iterable<Record<string, unknown>>;
  };
  close(): void;
}

interface ConversationDbLocation {
  gemini: string;
  database: string;
}

const sqlite = z
  .object({
    DatabaseSync: z.custom<new (path: string, options: { readOnly: true }) => ConversationDb>(
      (value) => typeof value === "function",
    ),
  })
  .safeParse(process.getBuiltinModule?.("node:sqlite"));
const conversationId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function flag(args: readonly string[], hyphen: string, underscore: string): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    const equals = arg.indexOf("=");
    const name = equals < 0 ? arg : arg.slice(0, equals);
    if (name !== hyphen && name !== underscore) continue;
    const next = equals < 0 ? args[i + 1] : arg.slice(equals + 1);
    if (next && (equals >= 0 || !next.startsWith("-"))) {
      value = next;
      if (equals < 0) i++;
    }
  }
  return value;
}

export function conversationDbPath(context: {
  nativeSessionId: string;
  agentVersion?: string;
  args: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
}): ConversationDbLocation | undefined {
  // The conversation DB is an internal format. This layout was verified with agy 1.5.14.
  const patch = /^1\.5\.(\d+)$/.exec(context.agentVersion ?? "")?.[1];
  if (
    !sqlite.success ||
    !patch ||
    Number(patch) < 14 ||
    !conversationId.test(context.nativeSessionId)
  ) {
    return undefined;
  }
  const { args, env } = context;
  const gemini = flag(args, "--gemini-dir", "--gemini_dir") ?? ".gemini";
  const app = flag(args, "--app-data-dir", "--app_data_dir") ?? "antigravity-cli";
  const home = process.platform === "win32" ? env.USERPROFILE : env.HOME;
  if (!path.isAbsolute(gemini) && (!home || !path.isAbsolute(home))) return undefined;
  if (path.isAbsolute(app) || app.split(/[/\\]/).includes("..")) return undefined;
  // Relative --gemini-dir is relative to the spawned process's home, not the workspace.
  return {
    gemini: path.resolve(home ?? "", gemini),
    database: path.join(app, "conversations", `${context.nativeSessionId}.db`),
  };
}

export function readConversationDb<T>(
  location: ConversationDbLocation,
  read: (db: ConversationDb) => T,
): T | undefined {
  if (!sqlite.success) return undefined;
  try {
    if (!lstatSync(location.gemini).isDirectory()) return undefined;
    const file = path.join(realpathSync(location.gemini), location.database);
    // Resolve the host's Gemini parent, but do not follow links within the native data directory.
    if (!lstatSync(file).isFile() || realpathSync(file) !== file) return undefined;
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = lstatSync(file + suffix, { throwIfNoEntry: false });
      if (sidecar && !sidecar.isFile()) return undefined;
    }
    const db = new sqlite.data.DatabaseSync(file, { readOnly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}
