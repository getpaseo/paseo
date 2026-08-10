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

  constructor(logger: pino.Logger, filePath: string, now: () => number, leaseMs: number) {
    this.logger = logger.child({ component: "token-store" });
    this.filePath = filePath;
    this.now = now;
    this.leaseMs = leaseMs;
    this.loadFromDisk();
  }

  renewToken(token: string): void {
    const normalized = token.trim();
    if (!normalized) return;
    const now = this.now();
    const currentExpiry = this.subscriptions.get(normalized);
    if (currentExpiry !== undefined && currentExpiry - now > this.leaseMs / 2) return;
    this.subscriptions.set(normalized, now + this.leaseMs);
    this.persist();
    this.logger.debug({ total: this.subscriptions.size }, "Renewed token");
  }

  revokeToken(token: string): void {
    const normalized = token.trim();
    if (!normalized) return;
    const deleted = this.subscriptions.delete(normalized);
    if (deleted) {
      this.persist();
      this.logger.debug({ total: this.subscriptions.size }, "Revoked token");
    }
  }

  getActiveTokens(): string[] {
    const now = this.now();
    let removedExpired = false;
    for (const [token, expiresAt] of this.subscriptions) {
      if (expiresAt <= now) {
        this.subscriptions.delete(token);
        removedExpired = true;
      }
    }
    if (removedExpired) {
      this.persist();
    }
    return Array.from(this.subscriptions.keys());
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.filePath)) {
        return;
      }
      ensurePrivateFile(this.filePath);
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as { subscriptions?: unknown; tokens?: unknown };
      const subscriptions = Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [];
      for (const value of subscriptions) {
        if (!value || typeof value !== "object") continue;
        const candidate = value as { token?: unknown; expiresAt?: unknown };
        if (typeof candidate.token !== "string" || typeof candidate.expiresAt !== "string")
          continue;
        const token = candidate.token.trim();
        const expiresAt = Date.parse(candidate.expiresAt);
        if (token && Number.isFinite(expiresAt)) {
          this.subscriptions.set(token, expiresAt);
        }
      }

      const legacyTokens = Array.isArray(parsed.tokens)
        ? parsed.tokens.filter((token): token is string => typeof token === "string")
        : [];
      if (legacyTokens.length > 0) {
        const expiresAt = this.now() + this.leaseMs;
        for (const token of legacyTokens) {
          const normalized = token.trim();
          if (normalized) this.subscriptions.set(normalized, expiresAt);
        }
        this.persist();
      }
      this.logger.info({ total: this.subscriptions.size }, "Loaded push tokens");
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to load push tokens");
    }
  }

  private persist(): void {
    try {
      const payload =
        JSON.stringify(
          {
            subscriptions: Array.from(this.subscriptions, ([token, expiresAt]) => ({
              token,
              expiresAt: new Date(expiresAt).toISOString(),
            })),
          },
          null,
          2,
        ) + "\n";
      writePrivateFileAtomicSync(this.filePath, payload);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to persist push tokens");
    }
  }
}
