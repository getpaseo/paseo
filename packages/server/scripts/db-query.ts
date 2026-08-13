import { resolvePaseoHome } from "../src/server/paseo-home.js";
import { openDatabase } from "../src/server/db/open.js";

const sql = process.argv.slice(2).join(" ").trim();
if (!sql) {
  throw new Error('Usage: npm run db:query -- "SELECT ..."');
}

const database = openDatabase(resolvePaseoHome());
try {
  const statement = database.prepare(sql);
  if (statement.columns().length > 0) {
    console.table(statement.all());
  } else {
    const result = statement.run();
    console.log(`changes: ${result.changes}`);
  }
} finally {
  database.close();
}
