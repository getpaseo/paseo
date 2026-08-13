import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
// node:sqlite emits an ExperimentalWarning on Node 22. We deliberately accept it instead of
// changing process-wide warning behavior; the startup smoke checks below pin the features we use.
import { DatabaseSync } from "node:sqlite";
import { PRIVATE_FILE_MODE } from "../private-files.js";
import { runMigrations } from "./migrations.js";

const MINIMUM_NODE_VERSION = [22, 20, 0] as const;
const BUSY_TIMEOUT_MS = 5_000;

function parseNodeVersion(version: string): readonly number[] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    throw new Error(`Unable to determine Node.js version from ${JSON.stringify(version)}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function assertSupportedNodeVersion(version = process.versions.node): void {
  const actual = parseNodeVersion(version);
  for (let index = 0; index < MINIMUM_NODE_VERSION.length; index += 1) {
    if (actual[index] > MINIMUM_NODE_VERSION[index]) {
      return;
    }
    if (actual[index] < MINIMUM_NODE_VERSION[index]) {
      throw new Error(`Paseo requires Node.js >=22.20.0 for SQLite support; running ${version}`);
    }
  }
}

function readJournalMode(database: DatabaseSync): string {
  const row = database.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  return row.journal_mode.toLowerCase();
}

function verifyFts5(database: DatabaseSync): void {
  try {
    database.exec("CREATE VIRTUAL TABLE temp.paseo_fts5_smoke USING fts5(content)");
    database.exec("DROP TABLE temp.paseo_fts5_smoke");
  } catch (error) {
    throw new Error("This Node.js runtime does not provide the required SQLite FTS5 support", {
      cause: error,
    });
  }
}

export function openDatabase(paseoHome: string): DatabaseSync {
  assertSupportedNodeVersion();
  mkdirSync(paseoHome, { recursive: true });
  const databasePath = join(paseoHome, "paseo.db");
  const database = new DatabaseSync(databasePath);
  try {
    chmodSync(databasePath, PRIVATE_FILE_MODE);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
    `);
    if (readJournalMode(database) !== "wal") {
      throw new Error("paseo.db could not enable required WAL journal mode");
    }
    verifyFts5(database);
    runMigrations(database);
    return database;
  } catch (error) {
    database.close();
    throw new Error(`Failed to initialize SQLite database at ${databasePath}`, { cause: error });
  }
}
