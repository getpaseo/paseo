import type { DatabaseSync } from "node:sqlite";
import { runInTransaction } from "./transaction.js";

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE legacy_imports (
        store TEXT PRIMARY KEY,
        imported_at TEXT NOT NULL,
        imported_count INTEGER NOT NULL,
        skipped_count INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        identity_key TEXT,
        payload TEXT NOT NULL
      ) STRICT;

      CREATE INDEX schedules_created_at_idx ON schedules(created_at);
      CREATE INDEX schedules_identity_key_idx ON schedules(identity_key);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE push_tokens (
        token TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      ) STRICT;
    `,
  },
];

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

export function runMigrations(database: DatabaseSync): void {
  const currentVersion = readUserVersion(database);
  const latestVersion = MIGRATIONS.at(-1)?.version ?? 0;
  if (currentVersion > latestVersion) {
    throw new Error(
      `paseo.db schema version ${currentVersion} is newer than this daemon supports (${latestVersion})`,
    );
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) {
      continue;
    }
    runInTransaction(database, () => {
      database.exec(migration.sql);
      database.exec(`PRAGMA user_version = ${migration.version}`);
    });
  }
}
