import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/db/schema";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

function createDb() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
  });
  return drizzle(pool, { schema });
}

export function getDb() {
  if (!_db) {
    _db = createDb();
  }
  return _db;
}

// Convenience export — lazy-initialized on first access
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop) {
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop];
  },
});
