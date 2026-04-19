import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { resolve } from "node:path";
import * as schema from "@/db/schema";

export type TestDb = NodePgDatabase<typeof schema>;

let container: StartedPostgreSqlContainer | undefined;
let pool: Pool | undefined;
let dbInstance: TestDb | undefined;

export async function setupTestDb(): Promise<TestDb> {
  if (dbInstance) return dbInstance;
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("hubcode_test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  dbInstance = drizzle(pool, { schema });
  await migrate(dbInstance, {
    migrationsFolder: resolve(__dirname, "../../drizzle"),
  });
  return dbInstance;
}

export async function teardownTestDb(): Promise<void> {
  await pool?.end();
  await container?.stop();
  container = undefined;
  pool = undefined;
  dbInstance = undefined;
}

/**
 * Reset all chat-related tables. Cascading FKs from channel wipe most of it;
 * isolated tables (user, organization, member) are cleaned separately so each
 * test starts from an empty slate.
 */
export async function resetDb(db: TestDb): Promise<void> {
  await db.execute(`
    TRUNCATE
      channel,
      message,
      attachment,
      reaction,
      mention,
      pin,
      channel_member,
      member,
      organization,
      "user"
    RESTART IDENTITY CASCADE
  `);
}
