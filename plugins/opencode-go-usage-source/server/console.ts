import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// @types/node@20 predates the node:sqlite typings; declare the slice we use.
interface CredentialStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
}
interface CredentialDatabase {
  prepare(sql: string): CredentialStatement;
  close(): void;
}
interface NodeSqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => CredentialDatabase;
}

/**
 * OpenCode keeps integration credentials in a `credential` table. The OpenCode
 * Console login is the OAuth credential under the `opencode` integration; the
 * API-key login used by `auth.json` is not part of this store.
 */
const loginValueSchema = z
  .object({
    type: z.literal("oauth"),
    access: z.string().min(1),
    expires: z.number().finite().optional(),
    metadata: z
      .object({
        accountID: z.string().optional(),
        email: z.string().optional(),
        orgID: z.string().optional(),
        orgName: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface ConsoleLogin {
  access: string;
  expires: number | null;
  accountID: string | null;
  email: string | null;
  orgName: string | null;
}

export function consoleDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(
    env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"),
    "opencode",
    "opencode.db",
  );
}

export async function readConsoleLogin(path = consoleDatabasePath()): Promise<ConsoleLogin | null> {
  // Held in a variable so TypeScript skips module resolution: @types/node@20 has no
  // node:sqlite typings yet, while the runtime (Node 22+ / Electron) provides it.
  const sqliteSpecifier: string = "node:sqlite";
  let sqlite: NodeSqliteModule;
  try {
    sqlite = (await import(sqliteSpecifier)) as unknown as NodeSqliteModule;
  } catch {
    return null; // runtime without node:sqlite
  }

  if (!existsSync(path)) return null;
  let db: CredentialDatabase | undefined;
  try {
    db = new sqlite.DatabaseSync(path, { readOnly: true });
    const rows = db
      .prepare(
        "SELECT value FROM credential WHERE integration_id = 'opencode' ORDER BY active DESC, time_updated DESC",
      )
      .all();
    for (const row of rows) {
      const raw = typeof row.value === "string" ? row.value : null;
      if (!raw) continue;
      let parsed: z.infer<typeof loginValueSchema>;
      try {
        parsed = loginValueSchema.parse(JSON.parse(raw));
      } catch {
        continue;
      }
      return {
        access: parsed.access,
        expires: parsed.expires ?? null,
        accountID: parsed.metadata?.accountID ?? null,
        email: parsed.metadata?.email ?? null,
        orgName: parsed.metadata?.orgName ?? null,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

const meterSchema = z.object({
  startsAt: z.string().optional(),
  resetsAt: z.string().nullable().optional(),
  limitMicroCents: z.string(),
  usedMicroCents: z.string(),
});

const consoleGoStatusSchema = z
  .object({
    product: z.string().nullable().optional(),
    renewalProduct: z.string().nullable().optional(),
    cancelAtPeriodEnd: z.boolean().optional(),
    access: z
      .object({
        startsAt: z.string().optional(),
        endsAt: z.string().optional(),
        meters: z
          .object({
            fiveHour: meterSchema.optional(),
            week: meterSchema.optional(),
            month: meterSchema.optional(),
          })
          .optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

export type ConsoleGoStatus = z.infer<typeof consoleGoStatusSchema>;

export type ConsoleGoStatusResult =
  | { kind: "ok"; status: ConsoleGoStatus }
  | { kind: "rejected"; httpStatus: number };

export async function fetchConsoleGoStatus(
  access: string,
  fetchApi: typeof fetch = fetch,
): Promise<ConsoleGoStatusResult> {
  const response = await fetchApi("https://opencode.ai/console/api/go/status", {
    headers: { Authorization: `Bearer ${access}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403)
    return { kind: "rejected", httpStatus: response.status };
  if (!response.ok) throw new Error(`OpenCode Console Go status API returned ${response.status}`);
  return { kind: "ok", status: consoleGoStatusSchema.parse(await response.json()) };
}
