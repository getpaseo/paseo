import Desktop from "../desktop/src/NativePaseoDesktop";
let pending = Promise.resolve();
function enqueue(operation) {
  const result = pending.then(operation);
  pending = result.catch(() => {});
  return result;
}
const connection = {
  async execAsync(sql) {
    Desktop.sqlite(sql, "batch");
  },
  async runAsync(sql, params = []) {
    Desktop.sqlite(sql, JSON.stringify(params));
  },
  async getAllAsync(sql, params = []) {
    return JSON.parse(Desktop.sqlite(sql, JSON.stringify(params)));
  },
};
export async function openDatabaseAsync(name) {
  if (name !== "paseo-replica-row-store.db") throw new Error(`Unknown GPUI database: ${name}`);
  return {
    execAsync: (...args) => enqueue(() => connection.execAsync(...args)),
    runAsync: (...args) => enqueue(() => connection.runAsync(...args)),
    getAllAsync: (...args) => enqueue(() => connection.getAllAsync(...args)),
    withExclusiveTransactionAsync: (operation) =>
      enqueue(async () => {
        await connection.execAsync("BEGIN IMMEDIATE");
        try {
          await operation(connection);
          await connection.execAsync("COMMIT");
        } catch (error) {
          await connection.execAsync("ROLLBACK");
          throw error;
        }
      }),
  };
}
