import type pino from "pino";
import { existsSync, readFileSync } from "node:fs";

import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

/**
 * Store for push notification subscriptions.
 *
 * Subscriptions are persisted to disk so pushes still work after daemon restarts.
 */
export interface ExpoPushSubscription {
  kind: "expo";
  token: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebPushSubscription {
  kind: "webPush";
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  createdAt: string;
  updatedAt: string;
}

export type PushSubscription = ExpoPushSubscription | WebPushSubscription;

export class PushTokenStore {
  private readonly logger: pino.Logger;
  private subscriptions: PushSubscription[] = [];
  private readonly filePath: string;

  constructor(logger: pino.Logger, filePath: string) {
    this.logger = logger.child({ component: "token-store" });
    this.filePath = filePath;
    this.loadFromDisk();
  }

  addToken(token: string): void {
    const normalized = token.trim();
    if (!normalized) return;
    const existing = this.subscriptions.find(
      (subscription) => subscription.kind === "expo" && subscription.token === normalized,
    );
    if (existing) return;
    const now = new Date().toISOString();
    this.subscriptions.push({
      kind: "expo",
      token: normalized,
      createdAt: now,
      updatedAt: now,
    });
    this.persist();
    this.logger.debug({ total: this.subscriptions.length }, "Added token");
  }

  removeToken(token: string): void {
    const normalized = token.trim();
    if (!normalized) return;
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter(
      (subscription) => subscription.kind !== "expo" || subscription.token !== normalized,
    );
    if (this.subscriptions.length !== before) {
      this.persist();
      this.logger.debug({ total: this.subscriptions.length }, "Removed token");
    }
  }

  upsertWebPushSubscription(input: Omit<WebPushSubscription, "createdAt" | "updatedAt">): void {
    const endpoint = input.endpoint.trim();
    const p256dh = input.keys.p256dh.trim();
    const auth = input.keys.auth.trim();
    if (!endpoint || !p256dh || !auth) return;
    const now = new Date().toISOString();
    const existing = this.subscriptions.find(
      (subscription) => subscription.kind === "webPush" && subscription.endpoint === endpoint,
    );
    if (existing?.kind === "webPush") {
      existing.keys = { p256dh, auth };
      existing.updatedAt = now;
    } else {
      this.subscriptions.push({
        kind: "webPush",
        endpoint,
        keys: { p256dh, auth },
        createdAt: now,
        updatedAt: now,
      });
    }
    this.persist();
    this.logger.debug({ total: this.subscriptions.length }, "Upserted Web Push subscription");
  }

  removeWebPushSubscription(endpoint: string): void {
    const normalized = endpoint.trim();
    if (!normalized) return;
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter(
      (subscription) => subscription.kind !== "webPush" || subscription.endpoint !== normalized,
    );
    if (this.subscriptions.length !== before) {
      this.persist();
      this.logger.debug({ total: this.subscriptions.length }, "Removed Web Push subscription");
    }
  }

  getAllTokens(): string[] {
    return this.subscriptions
      .filter((subscription): subscription is ExpoPushSubscription => subscription.kind === "expo")
      .map((subscription) => subscription.token);
  }

  getAllSubscriptions(): PushSubscription[] {
    return this.subscriptions.map(cloneSubscription);
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.filePath)) {
        return;
      }
      ensurePrivateFile(this.filePath);
      const raw = readFileSync(this.filePath, "utf-8");
      this.subscriptions = parsePersistedSubscriptions(JSON.parse(raw));
      this.logger.info({ total: this.subscriptions.length }, "Loaded push subscriptions");
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to load push subscriptions");
    }
  }

  private persist(): void {
    try {
      const payload =
        JSON.stringify({ version: 2, subscriptions: this.subscriptions }, null, 2) + "\n";
      writePrivateFileAtomicSync(this.filePath, payload);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to persist push subscriptions");
    }
  }
}

function parsePersistedSubscriptions(value: unknown): PushSubscription[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.subscriptions)) {
    return record.subscriptions.flatMap(parseSubscription);
  }
  if (Array.isArray(record.tokens)) {
    const now = new Date().toISOString();
    return record.tokens.flatMap((token): ExpoPushSubscription[] => {
      if (typeof token !== "string") return [];
      const normalized = token.trim();
      if (!normalized) return [];
      return [
        {
          kind: "expo",
          token: normalized,
          createdAt: now,
          updatedAt: now,
        },
      ];
    });
  }
  return [];
}

function parseSubscription(value: unknown): PushSubscription[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : null;
  const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : null;
  if (!createdAt || !updatedAt) return [];
  if (record.kind === "expo" && typeof record.token === "string") {
    return parseExpoSubscription(record.token, createdAt, updatedAt);
  }
  if (record.kind === "webPush" && typeof record.endpoint === "string") {
    return parseWebPushSubscription(record, createdAt, updatedAt);
  }
  return [];
}

function parseExpoSubscription(
  rawToken: string,
  createdAt: string,
  updatedAt: string,
): ExpoPushSubscription[] {
  const token = rawToken.trim();
  if (!token) return [];
  return [{ kind: "expo", token, createdAt, updatedAt }];
}

function parseWebPushSubscription(
  record: Record<string, unknown>,
  createdAt: string,
  updatedAt: string,
): WebPushSubscription[] {
  const keys = record.keys && typeof record.keys === "object" ? record.keys : null;
  const keyRecord = keys as Record<string, unknown> | null;
  const endpoint = typeof record.endpoint === "string" ? record.endpoint.trim() : "";
  const p256dh = typeof keyRecord?.p256dh === "string" ? keyRecord.p256dh.trim() : "";
  const auth = typeof keyRecord?.auth === "string" ? keyRecord.auth.trim() : "";
  if (!endpoint || !p256dh || !auth) return [];
  return [{ kind: "webPush", endpoint, keys: { p256dh, auth }, createdAt, updatedAt }];
}

function cloneSubscription(subscription: PushSubscription): PushSubscription {
  if (subscription.kind === "expo") {
    return { ...subscription };
  }
  return {
    ...subscription,
    keys: { ...subscription.keys },
  };
}
