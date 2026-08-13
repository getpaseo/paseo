import { existsSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type pino from "pino";
import { z } from "zod";

import { hasLegacyImportMarker, recordLegacyImportMarker } from "../db/legacy-imports.js";
import { runInTransaction } from "../db/transaction.js";
import { ensurePrivateFile } from "../private-files.js";

const LEGACY_IMPORT_STORE = "push_tokens";
const DEFAULT_LEASE_MS = 48 * 60 * 60 * 1000;
const PushTokenRecordSchema = z.object({
  token: z.string().trim().min(1),
  expiresAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
});

interface PushTokenStoreOptions {
  database: DatabaseSync;
  legacyFilePath: string;
  logger: pino.Logger;
  now?: () => number;
  leaseMs?: number;
}

interface PushTokenRow {
  payload: string;
}

/** Store for leased Expo push-token subscriptions. */
export class PushTokenStore {
  private readonly database: DatabaseSync;
  private readonly logger: pino.Logger;
  private readonly legacyFilePath: string;
  private readonly now: () => number;
  private readonly leaseMs: number;

  constructor(options: PushTokenStoreOptions) {
    this.database = options.database;
    this.logger = options.logger.child({ component: "token-store" });
    this.legacyFilePath = options.legacyFilePath;
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.importLegacyTokens();
  }

  renewToken(token: string): void {
    const normalized = token.trim();
    if (!normalized) return;

    const current = this.readToken(normalized);
    const now = this.now();
    if (current && Date.parse(current.expiresAt) - now > this.leaseMs / 2) return;

    const record = {
      token: normalized,
      expiresAt: new Date(now + this.leaseMs).toISOString(),
    };
    this.database
      .prepare(
        "INSERT INTO push_tokens (token, payload) VALUES (?, ?) " +
          "ON CONFLICT(token) DO UPDATE SET payload = excluded.payload",
      )
      .run(record.token, JSON.stringify(record));
    this.logger.debug({ total: this.count() }, "Renewed token");
  }

  revokeToken(token: string): void {
    const normalized = token.trim();
    if (!normalized) return;
    const result = this.database.prepare("DELETE FROM push_tokens WHERE token = ?").run(normalized);
    if (result.changes > 0) {
      this.logger.debug({ total: this.count() }, "Revoked token");
    }
  }

  getActiveTokens(): string[] {
    const now = this.now();
    const rows = this.database
      .prepare("SELECT payload FROM push_tokens ORDER BY rowid")
      .all() as unknown as PushTokenRow[];
    const active: string[] = [];
    const expired: string[] = [];
    for (const row of rows) {
      const record = PushTokenRecordSchema.parse(JSON.parse(row.payload));
      if (Date.parse(record.expiresAt) <= now) {
        expired.push(record.token);
      } else {
        active.push(record.token);
      }
    }
    if (expired.length > 0) {
      try {
        runInTransaction(this.database, () => {
          const remove = this.database.prepare("DELETE FROM push_tokens WHERE token = ?");
          for (const token of expired) remove.run(token);
        });
      } catch {
        // Expired tokens stay excluded and a later delivery retries pruning them.
      }
    }
    return active;
  }

  private readToken(token: string): z.infer<typeof PushTokenRecordSchema> | null {
    const row = this.database
      .prepare("SELECT payload FROM push_tokens WHERE token = ?")
      .get(token) as PushTokenRow | undefined;
    return row ? PushTokenRecordSchema.parse(JSON.parse(row.payload)) : null;
  }

  private count(): number {
    const row = this.database.prepare("SELECT count(*) AS count FROM push_tokens").get() as {
      count: number;
    };
    return row.count;
  }

  private importLegacyTokens(): void {
    if (hasLegacyImportMarker(this.database, LEGACY_IMPORT_STORE)) return;

    try {
      runInTransaction(this.database, () => {
        let importedCount = 0;
        let skippedCount = 0;
        if (this.count() === 0 && existsSync(this.legacyFilePath)) {
          ensurePrivateFile(this.legacyFilePath);
          const raw = readFileSync(this.legacyFilePath, "utf-8");
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch (error) {
            this.logger.warn(
              { err: error, filePath: this.legacyFilePath },
              "Skipping invalid legacy push token file",
            );
            skippedCount += 1;
          }

          const source = parsed && typeof parsed === "object" ? parsed : {};
          const subscriptions = Array.isArray((source as { subscriptions?: unknown }).subscriptions)
            ? (source as { subscriptions: unknown[] }).subscriptions
            : [];
          const tokens = Array.isArray((source as { tokens?: unknown }).tokens)
            ? (source as { tokens: unknown[] }).tokens.map((token) => ({
                token,
                expiresAt: new Date(this.now() + this.leaseMs).toISOString(),
              }))
            : [];

          for (const candidate of [...subscriptions, ...tokens]) {
            const record = PushTokenRecordSchema.safeParse(candidate);
            if (!record.success) {
              skippedCount += 1;
              this.logger.warn(
                { filePath: this.legacyFilePath, err: record.error },
                "Skipping invalid legacy push token",
              );
              continue;
            }
            const result = this.database
              .prepare("INSERT OR IGNORE INTO push_tokens (token, payload) VALUES (?, ?)")
              .run(record.data.token, JSON.stringify(record.data));
            importedCount += Number(result.changes);
          }
        }
        recordLegacyImportMarker(this.database, LEGACY_IMPORT_STORE, {
          importedCount,
          skippedCount,
        });
        this.logger.info({ importedCount, skippedCount }, "Legacy push token import complete");
      });
    } catch (error) {
      throw new Error(`Failed to import legacy push tokens from ${this.legacyFilePath}`, {
        cause: error,
      });
    }
  }
}
