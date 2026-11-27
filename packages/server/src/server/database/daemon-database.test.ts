import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  DatabaseClosedError,
  DatabaseOpenError,
  DatabaseSchemaTooNewError,
  openDaemonDatabase,
  type DaemonDatabase,
  type ReadSql,
  type SchemaModule,
  type WriteSql,
} from "./index.js";
import { WalCheckpointer } from "./internal/wal-checkpointer.js";

let directory: string;
let databasePath: string;
const opened: DaemonDatabase[] = [];

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "paseo-database-"));
  databasePath = path.join(directory, "paseo.db");
});

afterEach(() => {
  for (const database of opened.splice(0)) database.close();
  rmSync(directory, { recursive: true, force: true });
});

function open(modules: readonly SchemaModule[]): DaemonDatabase {
  const database = openDaemonDatabase({ path: databasePath, modules, logger: createTestLogger() });
  opened.push(database);
  return database;
}

function reopen(database: DaemonDatabase, modules: readonly SchemaModule[]): DaemonDatabase {
  database.close();
  return open(modules);
}

const notes: SchemaModule = {
  name: "notes",
  migrations: [
    {
      up: (sql) =>
        sql.exec("CREATE TABLE notes_items (id INTEGER PRIMARY KEY, text TEXT NOT NULL)"),
    },
  ],
};

function count(database: DaemonDatabase, table: string): number {
  return database.read((sql) => sql.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n);
}

function tableNames(database: DaemonDatabase): string[] {
  return database.read((sql) =>
    sql
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((row) => row.name),
  );
}

function versions(database: DaemonDatabase) {
  return database.read((sql) =>
    sql.all<{ module: string; version: number; min_reader_version: number }>(
      "SELECT module, version, min_reader_version FROM schema_versions ORDER BY module",
    ),
  );
}

describe("opening the daemon database", () => {
  it("creates the file in WAL mode with foreign keys on", () => {
    const database = open([notes]);
    expect(
      database.read((sql) => ({
        journal: sql.get<{ journal_mode: string }>("PRAGMA journal_mode")!.journal_mode,
        foreignKeys: sql.get<{ foreign_keys: number }>("PRAGMA foreign_keys")!.foreign_keys,
        synchronous: sql.get<{ synchronous: number }>("PRAGMA synchronous")!.synchronous,
      })),
    ).toEqual({ journal: "wal", foreignKeys: 1, synchronous: 1 });
    expect(versions(database)).toEqual([{ module: "notes", version: 1, min_reader_version: 1 }]);
  });

  it("keeps committed rows across a reopen and runs no migration twice", () => {
    let database = open([notes]);
    database.write((sql) => sql.run("INSERT INTO notes_items (text) VALUES (?)", "kept"));
    database = reopen(database, [notes]);
    expect(database.read((sql) => sql.all("SELECT text FROM notes_items"))).toEqual([
      { text: "kept" },
    ]);
    expect(versions(database)).toEqual([{ module: "notes", version: 1, min_reader_version: 1 }]);
  });

  it("runs only the pending migrations of a module that gained some", () => {
    let database = open([notes]);
    database.write((sql) => sql.run("INSERT INTO notes_items (text) VALUES ('a')"));
    database = reopen(database, [
      {
        name: "notes",
        migrations: [
          ...notes.migrations,
          { up: (sql) => sql.exec("ALTER TABLE notes_items ADD COLUMN pinned INTEGER") },
        ],
      },
    ]);
    expect(database.read((sql) => sql.all("SELECT text, pinned FROM notes_items"))).toEqual([
      { text: "a", pinned: null },
    ]);
    expect(versions(database)).toEqual([{ module: "notes", version: 2, min_reader_version: 1 }]);
  });

  it("migrates several modules independently", () => {
    const tags: SchemaModule = {
      name: "tags",
      migrations: [{ up: (sql) => sql.exec("CREATE TABLE tags_items (name TEXT)") }],
    };
    let database = open([notes]);
    database = reopen(database, [notes, tags]);
    expect(tableNames(database)).toEqual(["notes_items", "schema_versions", "tags_items"]);
    expect(versions(database).map((row) => [row.module, row.version])).toEqual([
      ["notes", 1],
      ["tags", 1],
    ]);
  });

  it("rolls every migration back when one fails, so the next open retries from the same state", () => {
    const failing: SchemaModule = {
      name: "notes",
      migrations: [
        ...notes.migrations,
        {
          up: (sql) => {
            sql.exec("CREATE TABLE notes_extra (id INTEGER)");
            throw new Error("migration bug");
          },
        },
      ],
    };
    expect(() =>
      openDaemonDatabase({ path: databasePath, modules: [failing], logger: createTestLogger() }),
    ).toThrow(DatabaseOpenError);
    const database = open([]);
    expect(tableNames(database)).toEqual(["schema_versions"]);
  });

  it("opens a database a newer daemon changed additively, and ignores stores it does not know", () => {
    const newer: SchemaModule = {
      name: "notes",
      migrations: [
        ...notes.migrations,
        { up: (sql) => sql.exec("ALTER TABLE notes_items ADD COLUMN pinned INTEGER") },
      ],
    };
    const unknownStore: SchemaModule = {
      name: "future",
      migrations: [{ up: (sql) => sql.exec("CREATE TABLE future_items (id INTEGER)") }],
    };
    let database = open([newer, unknownStore]);
    database.write((sql) => sql.run("INSERT INTO notes_items (text, pinned) VALUES ('a', 1)"));
    database = reopen(database, [notes]);
    expect(database.read((sql) => sql.all("SELECT text FROM notes_items"))).toEqual([
      { text: "a" },
    ]);
    expect(versions(database)).toEqual([
      { module: "future", version: 1, min_reader_version: 1 },
      { module: "notes", version: 2, min_reader_version: 1 },
    ]);
  });

  it("refuses a database a newer daemon changed in a way this daemon cannot read", () => {
    const breaking: SchemaModule = {
      name: "notes",
      migrations: [
        ...notes.migrations,
        { up: (sql) => sql.exec("DROP TABLE notes_items"), breaking: true },
      ],
    };
    open([breaking]).close();
    opened.length = 0;
    let error: unknown;
    try {
      openDaemonDatabase({ path: databasePath, modules: [notes], logger: createTestLogger() });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(DatabaseSchemaTooNewError);
    expect(error).toMatchObject({ module: "notes", minReaderVersion: 2, knownVersion: 1 });
    expect((error as Error).message).toContain(databasePath);
  });

  it("fails with the path when the file is not a database", () => {
    const corrupt = path.join(directory, "corrupt.db");
    writeFileSync(corrupt, "this is not a sqlite file, it is some text long enough to be read");
    let error: unknown;
    try {
      openDaemonDatabase({ path: corrupt, modules: [notes], logger: createTestLogger() });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(DatabaseOpenError);
    expect((error as Error).message).toContain(corrupt);
  });
});

function insert(sql: WriteSql, text: string): void {
  sql.run("INSERT INTO notes_items (text) VALUES (?)", text);
}

function insertThenThrow(sql: WriteSql, text: string): never {
  insert(sql, text);
  throw new Error(`failed after ${text}`);
}

function texts(database: DaemonDatabase): string[] {
  return database.read((sql) =>
    sql.all<{ text: string }>("SELECT text FROM notes_items ORDER BY id").map((row) => row.text),
  );
}

it.skipIf(process.platform === "win32")(
  "keeps the database and its WAL files private to the user, including a file created readable",
  () => {
    const umask = process.umask(0o022);
    try {
      writeFileSync(databasePath, "", { mode: 0o644 });
      const database = open([notes]);
      database.write((sql) => insert(sql, "secret"));
      for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
        expect({ file, mode: statSync(file).mode & 0o777 }).toEqual({ file, mode: 0o600 });
      }
    } finally {
      process.umask(umask);
    }
  },
);

it("rolls a write back when its callback throws", () => {
  const database = open([notes]);
  expect(() => database.write((sql) => insertThenThrow(sql, "lost"))).toThrow("failed after lost");
  expect(count(database, "notes_items")).toBe(0);
});

it("rolls back only a nested write that throws", () => {
  const database = open([notes]);
  const writeOuter = (sql: WriteSql) => {
    insert(sql, "outer");
    expect(() => database.write((inner) => insertThenThrow(inner, "inner"))).toThrow(
      "failed after inner",
    );
    database.write((inner) => insert(inner, "second"));
  };
  database.write(writeOuter);
  expect(texts(database)).toEqual(["outer", "second"]);
});

it("joins a read nested in a write, which sees the write's uncommitted rows", () => {
  const database = open([notes]);
  database.write((sql) => {
    insert(sql, "pending");
    expect(count(database, "notes_items")).toBe(1);
  });
});

it("refuses a write inside a read", () => {
  const database = open([notes]);
  const writeInsideRead = () => database.write((sql) => insert(sql, "late"));
  expect(() => database.read(writeInsideRead)).toThrow(/inside a read/);
});

it("refuses an asynchronous callback and rolls its work back", () => {
  const database = open([notes]);
  const writeAsync = async (sql: WriteSql) => insert(sql, "async");
  expect(() => database.write(writeAsync)).toThrow(/synchronous/);
  expect(count(database, "notes_items")).toBe(0);
});

it("invalidates a handle once its callback returns", () => {
  const database = open([notes]);
  let leaked: WriteSql | undefined;
  database.write((sql) => {
    leaked = sql;
  });
  expect(() => insert(leaked!, "late")).toThrow(/after its transaction/);
  expect(count(database, "notes_items")).toBe(0);
});

it("closes an unfinished iterator before the transaction ends", () => {
  const database = open([notes]);
  database.write((sql) => ["a", "b", "c"].forEach((text) => insert(sql, text)));
  let rest: Iterator<unknown> | undefined;
  const first = database.read((sql) => {
    const iterator = sql.iterate("SELECT text FROM notes_items ORDER BY id")[Symbol.iterator]();
    rest = iterator;
    return iterator.next().value;
  });
  expect(first).toEqual({ text: "a" });
  expect(() => rest!.next()).toThrow(/after its transaction/);
  // A statement left open makes schema changes fail with "database table is locked".
  database.write((sql) => sql.exec("DROP TABLE notes_items"));
  expect(tableNames(database)).toEqual(["schema_versions"]);
});

it("refuses to reuse a statement that an unfinished iterator holds", () => {
  const database = open([notes]);
  database.write((sql) => insert(sql, "a"));
  const query = "SELECT text FROM notes_items";
  const reuse = (sql: ReadSql) => {
    sql.iterate(query)[Symbol.iterator]().next();
    expect(() => sql.all(query)).toThrow(/already iterating/);
  };
  database.read(reuse);
});

it("checkpoints the WAL off the daemon thread, never during a write", async () => {
  const database = open([notes]);
  expect(
    database.read((sql) => sql.get<{ wal_autocheckpoint: number }>("PRAGMA wal_autocheckpoint")),
  ).toEqual({ wal_autocheckpoint: 0 });
  const fileSize = () => statSync(databasePath).size;
  const before = fileSize();
  const writeBatch = (sql: WriteSql) => {
    for (let row = 0; row < 50; row++) insert(sql, "x".repeat(1000));
  };
  for (let batch = 0; batch < 20; batch++) database.write(writeBatch);
  // Writes go to the WAL. Only a checkpoint copies them into the database file.
  await vi.waitFor(() => expect(fileSize()).toBeGreaterThan(before + 500_000), {
    timeout: 10_000,
    interval: 50,
  });
});

it("rejects every call after close", () => {
  const database = open([notes]);
  database.close();
  expect(() => database.read((sql) => sql.all("SELECT 1"))).toThrow(DatabaseClosedError);
  expect(() => database.close()).not.toThrow();
});

describe("the WAL checkpointer", () => {
  it("stops and closes its connection when asked, without reporting an exit", () => {
    open([notes]).write((sql) => insert(sql, "a"));
    let exited = false;
    const checkpointer = new WalCheckpointer({
      path: databasePath,
      logger: createTestLogger(),
      onExit: () => {
        exited = true;
      },
    });
    expect(checkpointer.stop()).toBe(true);
    expect(exited).toBe(false);
  });

  it("reports a worker that ends on its own, so the database can checkpoint itself again", async () => {
    let exited = false;
    const checkpointer = new WalCheckpointer({
      path: path.join(directory, "missing", "paseo.db"),
      logger: createTestLogger(),
      onExit: () => {
        exited = true;
      },
    });
    await vi.waitFor(() => expect(exited).toBe(true), { timeout: 10_000, interval: 20 });
    expect(checkpointer.stop()).toBe(true);
  });
});
