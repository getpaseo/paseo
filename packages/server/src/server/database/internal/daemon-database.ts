import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import type { Logger } from "pino";
import { WalCheckpointer } from "./wal-checkpointer.js";

export type SqlValue = SQLInputValue;

/** Queries available inside `DaemonDatabase.read`. A handle is valid only inside its callback. */
export interface ReadSql {
  get<T>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T>(sql: string, ...params: SqlValue[]): T[];
  /** Lazy rows. An unfinished iteration is closed when the callback returns. */
  iterate<T>(sql: string, ...params: SqlValue[]): Iterable<T>;
}

/** Queries available inside `DaemonDatabase.write`. */
export interface WriteSql extends ReadSql {
  run(sql: string, ...params: SqlValue[]): { changes: number };
  /** Runs one or more statements without caching them, for schema changes. */
  exec(sql: string): void;
}

export interface Migration {
  up(sql: WriteSql): void;
  /**
   * The change leaves the schema unreadable for a daemon that knows only the earlier migrations,
   * for example a dropped or renamed column. Additive changes leave this unset.
   */
  breaking?: boolean;
}

/** A store's schema: its tables, named with the store's prefix, and their migrations in order. */
export interface SchemaModule {
  name: string;
  /** Append-only. The module's version is the number of migrations applied. */
  migrations: readonly Migration[];
}

/**
 * The daemon's SQLite database. Calls are synchronous and run on the caller's thread, so
 * transactions never interleave. A callback must not be asynchronous: a transaction never spans
 * an `await`.
 */
export interface DaemonDatabase {
  /** One write transaction. A throw rolls it back. Nested in a write, it is a savepoint. */
  write<T>(fn: (sql: WriteSql) => T): T;
  /** One consistent read. Nested in a read or write, it joins the outer transaction. */
  read<T>(fn: (sql: ReadSql) => T): T;
  /** Checkpoints the WAL and closes the file. Later calls throw `DatabaseClosedError`. */
  close(): void;
}

export class DatabaseClosedError extends Error {
  constructor() {
    super("The daemon database is closed");
    this.name = "DatabaseClosedError";
  }
}

/** The database cannot be used: `node:sqlite` is missing, or the file cannot be opened or migrated. */
export class DatabaseOpenError extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(`Cannot open the Paseo database at ${path}: ${describeError(cause)}`, { cause });
    this.name = "DatabaseOpenError";
  }
}

/** A newer daemon changed a store's schema in a way this daemon cannot read. */
export class DatabaseSchemaTooNewError extends Error {
  constructor(
    readonly path: string,
    readonly module: string,
    readonly minReaderVersion: number,
    readonly knownVersion: number,
  ) {
    super(
      `The Paseo database at ${path} was changed by a newer Paseo: store '${module}' needs ` +
        `schema version ${minReaderVersion}, this daemon knows version ${knownVersion}. ` +
        "Update Paseo to use it.",
    );
    this.name = "DatabaseSchemaTooNewError";
  }
}

const BUSY_TIMEOUT_MS = 1000;
const JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Opens the database at `path`, creating the file when absent in a directory that must exist, and
 * brings every module's schema up to date in one transaction. Throws `DatabaseOpenError` or `DatabaseSchemaTooNewError`.
 */
export function openDaemonDatabase(input: {
  path: string;
  modules: readonly SchemaModule[];
  logger: Logger;
}): DaemonDatabase {
  let connection: DatabaseSync | undefined;
  try {
    const sqlite = loadSqlite();
    connection = new sqlite.DatabaseSync(input.path, { timeout: BUSY_TIMEOUT_MS });
    connection.exec(
      [
        "PRAGMA journal_mode = WAL",
        "PRAGMA synchronous = NORMAL",
        "PRAGMA foreign_keys = ON",
        `PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT_BYTES}`,
      ].join(";"),
    );
    const database = new SqliteDaemonDatabase(connection, input.logger);
    migrate(database, input.path, input.modules);
    if (input.path !== ":memory:") database.checkpointOffThread(input.path);
    return database;
  } catch (error) {
    connection?.close();
    if (error instanceof DatabaseSchemaTooNewError) throw error;
    throw new DatabaseOpenError(input.path, error);
  }
}

function loadSqlite(): typeof import("node:sqlite") {
  // Loaded on open, not imported: Node 22 warns that the module is experimental when it loads, and
  // CLI commands import this package without opening a database.
  // Node before 20.16 has no getBuiltinModule; the engines field does not stop a global install.
  const sqlite =
    typeof process.getBuiltinModule === "function"
      ? process.getBuiltinModule("node:sqlite")
      : undefined;
  if (!sqlite) {
    throw new Error(`node:sqlite is unavailable in Node ${process.versions.node}; use >= 22.16`);
  }
  return sqlite;
}

function migrate(database: DaemonDatabase, file: string, modules: readonly SchemaModule[]): void {
  database.write((sql) => {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS schema_versions (" +
        "module TEXT PRIMARY KEY, version INTEGER NOT NULL, min_reader_version INTEGER NOT NULL)",
    );
    const names = new Set<string>();
    for (const module of modules) {
      if (names.has(module.name)) throw new Error(`Schema module '${module.name}' is listed twice`);
      names.add(module.name);
      migrateModule(sql, file, module);
    }
  });
}

interface StoredVersion {
  version: number;
  min_reader_version: number;
}

function migrateModule(sql: WriteSql, file: string, module: SchemaModule): void {
  const known = module.migrations.length;
  const stored = sql.get<StoredVersion>(
    "SELECT version, min_reader_version FROM schema_versions WHERE module = ?",
    module.name,
  );
  if (stored && stored.min_reader_version > known) {
    throw new DatabaseSchemaTooNewError(file, module.name, stored.min_reader_version, known);
  }
  const from = stored?.version ?? 0;
  if (from >= known) return;
  // The first migration creates the store, so no daemon that predates it can read the store.
  let minReaderVersion = Math.max(stored?.min_reader_version ?? 0, 1);
  for (let index = from; index < known; index++) {
    const migration = module.migrations[index];
    migration.up(sql);
    if (migration.breaking) minReaderVersion = index + 1;
  }
  sql.run(
    "INSERT INTO schema_versions (module, version, min_reader_version) VALUES (?, ?, ?) " +
      "ON CONFLICT (module) DO UPDATE SET version = excluded.version, " +
      "min_reader_version = excluded.min_reader_version",
    module.name,
    known,
    minReaderVersion,
  );
}

type TransactionState = "none" | "read" | "write";

/** Who checkpoints the WAL: SQLite on each commit, a worker not yet started, or the worker. */
type CheckpointerState =
  | { kind: "on_thread" }
  | { kind: "pending"; path: string }
  | { kind: "worker"; worker: WalCheckpointer };

const SQLITE_DEFAULT_AUTOCHECKPOINT_PAGES = 1000;

interface OpenIteration {
  close(): void;
}

class SqliteDaemonDatabase implements DaemonDatabase {
  private state: TransactionState = "none";
  private savepoints = 0;
  private closed = false;
  private readonly statements = new Map<string, StatementSync>();
  private readonly iterating = new Set<StatementSync>();
  private checkpointer: CheckpointerState = { kind: "on_thread" };

  constructor(
    private readonly connection: DatabaseSync,
    private readonly logger: Logger,
  ) {}

  write<T>(fn: (sql: WriteSql) => T): T {
    this.assertOpen();
    if (this.state === "read") throw new Error("Cannot write inside a read transaction");
    if (this.state === "write") return this.savepoint(fn);
    return this.transaction("write", "BEGIN IMMEDIATE", fn);
  }

  read<T>(fn: (sql: ReadSql) => T): T {
    this.assertOpen();
    if (this.state !== "none") return this.scoped(fn);
    return this.transaction("read", "BEGIN", fn);
  }

  /**
   * Moves WAL checkpoints to a worker thread, started by the first committed write, so a
   * read-only open starts no thread. Until then SQLite's auto-checkpoint stays off.
   */
  checkpointOffThread(file: string): void {
    this.connection.exec("PRAGMA wal_autocheckpoint = 0");
    this.checkpointer = { kind: "pending", path: file };
  }

  close(): void {
    if (this.closed) return;
    if (this.state !== "none") throw new Error("Cannot close the database inside a transaction");
    this.closed = true;
    if (this.checkpointer.kind === "worker" && !this.checkpointer.worker.stop()) {
      this.logger.warn("Database WAL checkpointer did not stop before close");
    }
    try {
      const result = this.connection.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
        | { busy: number }
        | undefined;
      if (result?.busy) this.logger.warn("Database WAL checkpoint was blocked by another reader");
    } catch (error) {
      this.logger.warn({ err: error }, "Database WAL checkpoint failed before close");
    }
    this.statements.clear();
    this.connection.close();
  }

  private transaction<T>(state: TransactionState, begin: string, fn: (sql: WriteSql) => T): T {
    this.connection.exec(begin);
    this.state = state;
    try {
      const result = this.scoped(fn);
      this.connection.exec("COMMIT");
      if (state === "write") this.startPendingCheckpointer();
      return result;
    } catch (error) {
      if (this.connection.isTransaction) this.connection.exec("ROLLBACK");
      throw error;
    } finally {
      this.state = "none";
    }
  }

  private savepoint<T>(fn: (sql: WriteSql) => T): T {
    const name = `paseo_${++this.savepoints}`;
    this.connection.exec(`SAVEPOINT ${name}`);
    try {
      const result = this.scoped(fn);
      this.connection.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.connection.exec(`ROLLBACK TO ${name}`);
      this.connection.exec(`RELEASE ${name}`);
      throw error;
    } finally {
      this.savepoints--;
    }
  }

  /** Runs `fn` with a handle that stops working, and closes its iterations, when `fn` returns. */
  private scoped<T>(fn: (sql: WriteSql) => T): T {
    let valid = true;
    const iterations = new Set<OpenIteration>();
    const assertValid = () => {
      if (!valid) throw new Error("A database handle was used after its transaction ended");
    };
    const statement = (sql: string) => {
      assertValid();
      const prepared = this.statement(sql);
      if (this.iterating.has(prepared)) {
        throw new Error(`A statement is already iterating: ${sql}`);
      }
      return prepared;
    };
    const handle: WriteSql = {
      get: <R>(sql: string, ...params: SqlValue[]) =>
        statement(sql).get(...params) as R | undefined,
      all: <R>(sql: string, ...params: SqlValue[]) => statement(sql).all(...params) as R[],
      iterate: <R>(sql: string, ...params: SqlValue[]) =>
        this.iterate<R>(statement(sql), params, iterations, assertValid),
      run: (sql: string, ...params: SqlValue[]) => ({
        changes: Number(statement(sql).run(...params).changes),
      }),
      exec: (sql: string) => {
        assertValid();
        this.connection.exec(sql);
      },
    };
    try {
      const result = fn(handle);
      if (isThenable(result)) {
        throw new Error("A database transaction callback must be synchronous");
      }
      return result;
    } finally {
      valid = false;
      for (const iteration of iterations) iteration.close();
    }
  }

  private iterate<R>(
    prepared: StatementSync,
    params: SqlValue[],
    iterations: Set<OpenIteration>,
    assertValid: () => void,
  ): Iterable<R> {
    const rows = prepared.iterate(...params);
    let done = false;
    const iteration: OpenIteration = {
      close: () => {
        if (done) return;
        done = true;
        this.iterating.delete(prepared);
        iterations.delete(iteration);
        rows.return?.();
      },
    };
    this.iterating.add(prepared);
    iterations.add(iteration);
    const iterator: Iterator<R> = {
      next: () => {
        assertValid();
        if (done) return { done: true, value: undefined };
        const next = rows.next();
        if (next.done) iteration.close();
        return next.done
          ? { done: true, value: undefined }
          : { done: false, value: next.value as R };
      },
      return: () => {
        iteration.close();
        return { done: true, value: undefined };
      },
    };
    return { [Symbol.iterator]: () => iterator };
  }

  private startPendingCheckpointer(): void {
    if (this.checkpointer.kind !== "pending") return;
    const worker = new WalCheckpointer({
      path: this.checkpointer.path,
      logger: this.logger,
      onExit: () => this.checkpointOnThread(),
    });
    this.checkpointer = { kind: "worker", worker };
  }

  /** The worker ended on its own: let SQLite checkpoint again, so the WAL stays bounded. */
  private checkpointOnThread(): void {
    if (this.closed) return;
    this.logger.warn("Database WAL checkpointer exited; checkpointing on the daemon thread");
    this.checkpointer = { kind: "on_thread" };
    this.connection.exec(`PRAGMA wal_autocheckpoint = ${SQLITE_DEFAULT_AUTOCHECKPOINT_PAGES}`);
  }

  private statement(sql: string): StatementSync {
    let prepared = this.statements.get(sql);
    if (!prepared) {
      prepared = this.connection.prepare(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
  }

  private assertOpen(): void {
    if (this.closed) throw new DatabaseClosedError();
  }
}

function isThenable(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
