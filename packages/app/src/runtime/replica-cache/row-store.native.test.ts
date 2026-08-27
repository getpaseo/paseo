import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { runReplicaRowStoreContract } from "./row-store.contract";
import {
  createSqliteReplicaRowStore,
  type ReplicaSqliteConnection,
  type ReplicaSqliteDriver,
  type SqliteValue,
} from "./row-store-sqlite";

function createNodeSqliteDriver(): ReplicaSqliteDriver {
  const database = new DatabaseSync(":memory:");

  function connection(): ReplicaSqliteConnection {
    return {
      async exec(sql) {
        database.exec(sql);
      },
      async run(sql, params = []) {
        database.prepare(sql).run(...(params as SQLInputValue[]));
      },
      async all<Row>(sql: string, params: readonly SqliteValue[] = []) {
        return database.prepare(sql).all(...(params as SQLInputValue[])) as Row[];
      },
      async transaction(operation) {
        database.exec("BEGIN IMMEDIATE");
        try {
          await operation(connection());
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      },
    };
  }

  return {
    async open() {
      return connection();
    },
  };
}

runReplicaRowStoreContract("SQLite", async () => {
  const driver = createNodeSqliteDriver();
  return {
    store: createSqliteReplicaRowStore(driver, 1),
    async openWithSchemaVersion(schemaVersion) {
      const store = createSqliteReplicaRowStore(driver, schemaVersion);
      await store.open();
      return store;
    },
  };
});
