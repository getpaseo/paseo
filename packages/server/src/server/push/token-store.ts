import type pino from "pino";
import { existsSync, readFileSync } from "node:fs";

import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

/**
 * Store for Expo push tokens.
 *
 * Tokens are persisted to disk so pushes still work after daemon restarts.
 */
export class PushTokenStore {
  private readonly logger: pino.Logger;
  private subscriptions = new Map<string, number>();
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly write: typeof writePrivateFileAtomicSync;

  constructor(
    logger: pino.Logger,
    filePath: string,
    now: () => number,
    leaseMs: number,
    write: typeof writePrivateFileAtomicSync = writePrivateFileAtomicSync,
  ) {
    this.logger = logger.child({ component: "token-store" });
    this.filePath = filePath;
    this.now = now;
    this.leaseMs = leaseMs;
    this.write = write;
    this.loadFromDisk();
  }

  renewToken(token: string): void {
    const normalized = token.trim();
    if (!normalized) return;
    if (normalized.length > 512) throw new Error("Push token exceeds the supported length");
    const now = this.now();
    const currentExpiry = this.subscriptions.get(normalized);
    if (
      currentExpiry !== undefined &&
      currentExpiry - now > this.leaseMs - Math.min(24 * 60 * 60 * 1000, this.leaseMs / 2)
    )
      return;
    const next = new Map(this.subscriptions);
    for (const [registered, expiresAt] of next) {
      if (expiresAt <= now) next.delete(registered);
    }
    if (!next.has(normalized) && next.size >= 1000) throw new Error("Push device limit reached");
    next.set(normalized, now + this.leaseMs);
    this.persist(next);
    this.subscriptions = next;
    this.logger.debug({ total: this.subscriptions.size }, "Renewed token");
  }

  revokeToken(token: string): void {
    const normalized = token.trim();
    if (!normalized) return;
    if (!this.subscriptions.has(normalized)) return;
    const next = new Map(this.subscriptions);
    next.delete(normalized);
    this.persist(next);
    this.subscriptions = next;
    this.logger.debug({ total: this.subscriptions.size }, "Revoked token");
  }

  getActiveTokens(): string[] {
    const now = this.now();
    const active = new Map(this.subscriptions);
    for (const [token, expiresAt] of this.subscriptions) {
      if (expiresAt <= now) {
        active.delete(token);
      }
    }
    if (active.size !== this.subscriptions.size) {
      try {
        this.persist(active);
        this.subscriptions = active;
      } catch {
        // Keep the previous state so a later send retries pruning. Expired tokens
        // are still excluded from this delivery.
      }
    }
    return Array.from(active.keys());
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.filePath)) {
        return;
      }
      ensurePrivateFile(this.filePath);
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as {
        subscriptions?: unknown;
        tokens?: unknown;
        retentionMs?: unknown;
      };
      const loaded = new Map<string, number>();
      const subscriptions = Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [];
      for (const value of subscriptions) {
        if (!value || typeof value !== "object") continue;
        const candidate = value as { token?: unknown; expiresAt?: unknown };
        if (typeof candidate.token !== "string" || typeof candidate.expiresAt !== "string")
          continue;
        const token = candidate.token.trim();
        const expiresAt = Date.parse(candidate.expiresAt);
        if (token && token.length <= 512 && loaded.size < 1000 && Number.isFinite(expiresAt)) {
          // v0.11.2 stored a 48-hour lease. Preserve the original registration age
          // when migrating to the longer inactivity policy, including expired leases.
          const previousRetention =
            typeof parsed.retentionMs === "number" && Number.isFinite(parsed.retentionMs)
              ? parsed.retentionMs
              : 48 * 60 * 60 * 1000;
          loaded.set(token, expiresAt - previousRetention + this.leaseMs);
        }
      }
      this.subscriptions = loaded;
      if (parsed.retentionMs !== this.leaseMs && loaded.size > 0) this.persist(loaded);

      this.loadLegacyTokens(parsed.tokens, loaded);
      this.logger.info({ total: this.subscriptions.size }, "Loaded push tokens");
    } catch {
      this.logger.warn({ category: "read_or_parse" }, "Failed to load push tokens");
    }
  }

  private loadLegacyTokens(tokens: unknown, loaded: Map<string, number>): void {
    const legacyTokens = Array.isArray(tokens)
      ? tokens.filter((token): token is string => typeof token === "string")
      : [];
    if (legacyTokens.length > 0) {
      const migrated = new Map(loaded);
      const expiresAt = this.now() + this.leaseMs;
      for (const token of legacyTokens) {
        const normalized = token.trim();
        if (normalized && normalized.length <= 512 && migrated.size < 1000)
          migrated.set(normalized, expiresAt);
      }
      this.persist(migrated);
      this.subscriptions = migrated;
    }
  }

  private persist(subscriptions: ReadonlyMap<string, number>): void {
    try {
      const payload =
        JSON.stringify(
          {
            retentionMs: this.leaseMs,
            subscriptions: Array.from(subscriptions, ([token, expiresAt]) => ({
              token,
              expiresAt: new Date(expiresAt).toISOString(),
            })),
          },
          null,
          2,
        ) + "\n";
      this.write(this.filePath, payload);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to persist push tokens");
      throw err;
    }
  }
}
