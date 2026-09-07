import type { ReplicaHostRows, ReplicaRow, ReplicaRowChanges, ReplicaRowStore } from "./row-store";

export type SqliteValue = string | number | null;

export interface ReplicaSqliteConnection {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: readonly SqliteValue[]): Promise<void>;
  all<Row>(sql: string, params?: readonly SqliteValue[]): Promise<Row[]>;
  transaction(operation: (connection: ReplicaSqliteConnection) => Promise<void>): Promise<void>;
}

export interface ReplicaSqliteDriver {
  open(): Promise<ReplicaSqliteConnection>;
}

const CREATE_ROWS_SQL = `
  CREATE TABLE IF NOT EXISTS rows (
    server_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('agent', 'workspace', 'project', 'timeline', 'checkpoint')),
    id TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (server_id, kind, id)
  )
`;

const CREATE_META_SQL = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  )
`;

interface StoredMeta {
  value: string;
}

interface StoredRow {
  server_id: string;
  kind: ReplicaRow["kind"];
  id: string;
  payload: string;
}

export function createSqliteReplicaRowStore(
  driver: ReplicaSqliteDriver,
  schemaVersion: number,
): ReplicaRowStore {
  let connection: ReplicaSqliteConnection | null = null;
  let opening: Promise<void> | null = null;

  function getConnection(): ReplicaSqliteConnection {
    if (!connection) {
      throw new Error("Replica row store has not been opened");
    }
    return connection;
  }

  async function open(): Promise<void> {
    opening ??= (async () => {
      const openedConnection = await driver.open();
      await openedConnection.exec(CREATE_META_SQL);
      const storedMeta = await openedConnection.all<StoredMeta>(
        "SELECT value FROM meta WHERE key = ?",
        ["schema_version"],
      );

      if (storedMeta[0]?.value !== String(schemaVersion)) {
        await openedConnection.transaction(async (transaction) => {
          await transaction.exec("DROP TABLE IF EXISTS rows");
          await transaction.exec(CREATE_ROWS_SQL);
          await transaction.run("DELETE FROM meta");
          await transaction.run("INSERT INTO meta (key, value) VALUES (?, ?)", [
            "schema_version",
            String(schemaVersion),
          ]);
        });
      } else {
        await openedConnection.exec(CREATE_ROWS_SQL);
      }

      connection = openedConnection;
    })();

    try {
      await opening;
    } catch (error) {
      opening = null;
      throw error;
    }
  }

  async function readAll(): Promise<ReplicaHostRows[]> {
    const storedRows = await getConnection().all<StoredRow>(
      "SELECT server_id, kind, id, payload FROM rows ORDER BY server_id, kind, id",
    );
    const hosts = new Map<string, ReplicaRow[]>();
    for (const storedRow of storedRows) {
      const rows = hosts.get(storedRow.server_id) ?? [];
      rows.push({
        serverId: storedRow.server_id,
        kind: storedRow.kind,
        id: storedRow.id,
        payload: storedRow.payload,
      });
      hosts.set(storedRow.server_id, rows);
    }
    return Array.from(hosts, ([serverId, rows]) => ({ serverId, rows }));
  }

  async function read(
    serverIds: readonly string[],
    kinds: readonly ReplicaRow["kind"][],
    ids?: readonly string[],
  ): Promise<ReplicaRow[]> {
    if (!serverIds.length || !kinds.length || ids?.length === 0) return [];
    const placeholders = (values: readonly string[]) => values.map(() => "?").join(",");
    const rows = await getConnection().all<StoredRow>(
      `SELECT server_id, kind, id, payload FROM rows WHERE server_id IN (${placeholders(serverIds)}) AND kind IN (${placeholders(kinds)})${ids ? ` AND id IN (${placeholders(ids)})` : ""} ORDER BY server_id, kind, id`,
      [...serverIds, ...kinds, ...(ids ?? [])],
    );
    return rows.map((row) => ({
      serverId: row.server_id,
      kind: row.kind,
      id: row.id,
      payload: row.payload,
    }));
  }

  async function apply(changes: ReplicaRowChanges): Promise<void> {
    await getConnection().transaction(async (transaction) => {
      for (const key of changes.deletes) {
        await transaction.run("DELETE FROM rows WHERE server_id = ? AND kind = ? AND id = ?", [
          key.serverId,
          key.kind,
          key.id,
        ]);
      }
      for (const row of changes.upserts) {
        await transaction.run(
          `INSERT INTO rows (server_id, kind, id, payload) VALUES (?, ?, ?, ?)
           ON CONFLICT (server_id, kind, id) DO UPDATE SET payload = excluded.payload`,
          [row.serverId, row.kind, row.id, row.payload],
        );
      }
    });
  }

  async function deleteHost(serverId: string): Promise<void> {
    await getConnection().run("DELETE FROM rows WHERE server_id = ?", [serverId]);
  }

  async function renameHost(oldServerId: string, newServerId: string): Promise<void> {
    if (oldServerId === newServerId) return;
    await getConnection().transaction(async (transaction) => {
      await transaction.run(
        `INSERT INTO rows (server_id, kind, id, payload)
         SELECT ?, kind, id, payload FROM rows WHERE server_id = ?
         ON CONFLICT (server_id, kind, id) DO UPDATE SET payload = excluded.payload`,
        [newServerId, oldServerId],
      );
      await transaction.run("DELETE FROM rows WHERE server_id = ?", [oldServerId]);
    });
  }

  async function clear(): Promise<void> {
    await getConnection().run("DELETE FROM rows");
  }

  return { open, read, readAll, apply, deleteHost, renameHost, clear };
}
