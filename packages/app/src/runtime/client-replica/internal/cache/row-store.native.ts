import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import type { ReplicaRowStore } from "./row-store";
import { REPLICA_ROW_STORE_SCHEMA_VERSION } from "./row-store-schema";
import {
  createSqliteReplicaRowStore,
  type ReplicaSqliteConnection,
  type ReplicaSqliteDriver,
  type SqliteValue,
} from "./row-store-sqlite";

export type {
  ReplicaHostRows,
  ReplicaRow,
  ReplicaRowChanges,
  ReplicaRowKey,
  ReplicaRowKind,
  ReplicaRowStore,
} from "./row-store";
export { REPLICA_ROW_STORE_SCHEMA_VERSION, REPLICA_SINGLETON_ROW_ID } from "./row-store-schema";

const DATABASE_NAME = "paseo-replica-row-store.db";

function bind(params: readonly SqliteValue[]): SqliteValue[] {
  return [...params];
}

function createConnection(database: SQLiteDatabase): ReplicaSqliteConnection {
  return {
    exec: (sql) => database.execAsync(sql),
    run: async (sql, params = []) => {
      await database.runAsync(sql, bind(params));
    },
    all: (sql, params = []) => database.getAllAsync(sql, bind(params)),
    transaction: (operation) =>
      database.withExclusiveTransactionAsync(async (transaction) => {
        await operation(createConnection(transaction));
      }),
  };
}

const expoSqliteDriver: ReplicaSqliteDriver = {
  async open() {
    return createConnection(await openDatabaseAsync(DATABASE_NAME));
  },
};

export function createReplicaRowStore(): ReplicaRowStore {
  return createSqliteReplicaRowStore(expoSqliteDriver, REPLICA_ROW_STORE_SCHEMA_VERSION);
}
