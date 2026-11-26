import type pino from "pino";
import { existsSync, readFileSync } from "node:fs";
import {
  normalizeNotificationPreferences,
  type NotificationPreferences,
  type NotificationPreferencesInput,
} from "@getpaseo/protocol/notification-preferences";

import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

export interface PushTokenSubscription {
  token: string;
  expiresAt: number;
  preferences?: NotificationPreferences;
}

interface StoredSubscriptionEntry {
  expiresAt: number;
  preferences?: NotificationPreferences;
}

function areNotificationPreferencesEqual(
  left: NotificationPreferences | undefined,
  right: NotificationPreferences | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.enabled !== right.enabled) return false;
  if (
    left.events.agentPermission !== right.events.agentPermission ||
    left.events.agentError !== right.events.agentError ||
    left.events.agentFinished !== right.events.agentFinished ||
    left.events.terminalNeedsInput !== right.events.terminalNeedsInput ||
    left.events.terminalFinished !== right.events.terminalFinished
  ) {
    return false;
  }
  if (left.plugins.enabled !== right.plugins.enabled) return false;
  if (left.plugins.muted.length !== right.plugins.muted.length) return false;
  return left.plugins.muted.every((pluginId, index) => pluginId === right.plugins.muted[index]);
}

function parsePersistedSubscription(value: unknown): [string, StoredSubscriptionEntry] | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    token?: unknown;
    expiresAt?: unknown;
    preferences?: unknown;
  };
  if (typeof candidate.token !== "string" || typeof candidate.expiresAt !== "string") {
    return null;
  }
  const token = candidate.token.trim();
  const expiresAt = Date.parse(candidate.expiresAt);
  if (!token || !Number.isFinite(expiresAt)) {
    return null;
  }
  const preferences =
    candidate.preferences && typeof candidate.preferences === "object"
      ? normalizeNotificationPreferences(candidate.preferences)
      : undefined;
  return [
    token,
    {
      expiresAt,
      ...(preferences !== undefined ? { preferences } : {}),
    },
  ];
}

/**
 * Store for Expo push tokens.
 *
 * Tokens are persisted to disk so pushes still work after daemon restarts.
 */
export class PushTokenStore {
  private readonly logger: pino.Logger;
  private subscriptions = new Map<string, StoredSubscriptionEntry>();
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

  renewToken(token: string, preferences?: NotificationPreferencesInput): void {
    const normalized = token.trim();
    if (!normalized) return;
    const now = this.now();
    const current = this.subscriptions.get(normalized);
    const normalizedPreferences =
      preferences !== undefined ? normalizeNotificationPreferences(preferences) : undefined;
    const nextPreferences = normalizedPreferences ?? current?.preferences;
    const preferencesChanged =
      normalizedPreferences !== undefined &&
      !areNotificationPreferencesEqual(current?.preferences, normalizedPreferences);

    if (
      current !== undefined &&
      current.expiresAt - now > this.leaseMs / 2 &&
      !preferencesChanged
    ) {
      return;
    }
    const next = new Map(this.subscriptions);
    next.set(normalized, {
      expiresAt: now + this.leaseMs,
      ...(nextPreferences !== undefined ? { preferences: nextPreferences } : {}),
    });
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

  getActiveSubscriptions(): PushTokenSubscription[] {
    const now = this.now();
    const active = new Map(this.subscriptions);
    for (const [token, entry] of this.subscriptions) {
      if (entry.expiresAt <= now) {
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
    return Array.from(active, ([token, entry]) => ({
      token,
      expiresAt: entry.expiresAt,
      ...(entry.preferences !== undefined ? { preferences: entry.preferences } : {}),
    }));
  }

  getActiveTokens(): string[] {
    return this.getActiveSubscriptions().map((entry) => entry.token);
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.filePath)) {
        return;
      }
      ensurePrivateFile(this.filePath);
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as { subscriptions?: unknown; tokens?: unknown };
      const loaded = new Map<string, StoredSubscriptionEntry>();
      const subscriptions = Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [];
      for (const value of subscriptions) {
        const parsedEntry = parsePersistedSubscription(value);
        if (parsedEntry) {
          loaded.set(parsedEntry[0], parsedEntry[1]);
        }
      }
      this.subscriptions = loaded;

      const legacyTokens = Array.isArray(parsed.tokens)
        ? parsed.tokens.filter((token): token is string => typeof token === "string")
        : [];
      if (legacyTokens.length > 0) {
        const migrated = new Map(loaded);
        const expiresAt = this.now() + this.leaseMs;
        for (const token of legacyTokens) {
          const normalized = token.trim();
          if (normalized) {
            const existing = migrated.get(normalized);
            migrated.set(normalized, {
              expiresAt,
              ...(existing?.preferences !== undefined ? { preferences: existing.preferences } : {}),
            });
          }
        }
        this.persist(migrated);
        this.subscriptions = migrated;
      }
      this.logger.info({ total: this.subscriptions.size }, "Loaded push tokens");
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to load push tokens");
    }
  }

  private persist(subscriptions: ReadonlyMap<string, StoredSubscriptionEntry>): void {
    try {
      const payload =
        JSON.stringify(
          {
            subscriptions: Array.from(subscriptions, ([token, entry]) => ({
              token,
              expiresAt: new Date(entry.expiresAt).toISOString(),
              ...(entry.preferences !== undefined ? { preferences: entry.preferences } : {}),
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
