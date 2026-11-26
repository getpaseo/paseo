import { randomUUID } from "node:crypto";
import type {
  PluginNotificationOpenTarget,
  PluginNotificationSendResult,
} from "@getpaseo/plugin/server";
import type { JsonValue } from "@getpaseo/protocol/agent-types";

export const MAX_PLUGIN_NOTIFICATION_TITLE_CHARS = 160;
export const MAX_PLUGIN_NOTIFICATION_BODY_CHARS = 500;
export const MAX_PLUGIN_NOTIFICATION_KEY_CHARS = 128;
export const MAX_PLUGIN_NOTIFICATION_DATA_BYTES = 1024;
export const PLUGIN_NOTIFICATION_DEDUP_WINDOW_MS = 60_000;
export const MAX_DEDUP_KEYS_PER_PLUGIN = 512;
export const PLUGIN_NOTIFICATION_BURST_CAPACITY = 10;
export const PLUGIN_NOTIFICATION_REFILL_INTERVAL_MS = 6_000;

const ALLOWED_INPUT_KEYS = new Set(["title", "body", "key", "open", "data"]);

export interface NormalizedPluginNotificationInput {
  title: string;
  body: string;
  key?: string;
  open?: PluginNotificationOpenTarget;
  data?: Record<string, JsonValue>;
}

export interface ValidatedPluginNotification {
  pluginId: string;
  notificationId: string;
  title: string;
  body: string;
  open?: PluginNotificationOpenTarget;
  data?: Record<string, JsonValue>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((item) => isJsonValue(item, seen));
    }
    if (!isPlainObject(value)) {
      return false;
    }
    return Object.values(value).every((item) => isJsonValue(item, seen));
  } finally {
    seen.delete(value);
  }
}

function validateOpenTarget(raw: unknown): PluginNotificationOpenTarget {
  if (!isPlainObject(raw) || typeof raw.type !== "string") {
    throw new Error("Invalid plugin notification open target");
  }
  if (raw.type === "agent") {
    if (
      Object.keys(raw).some((key) => key !== "type" && key !== "agentId") ||
      typeof raw.agentId !== "string"
    ) {
      throw new Error("Plugin notification open.agentId must be a non-empty string");
    }
    const agentId = raw.agentId.trim();
    if (!agentId) {
      throw new Error("Plugin notification open.agentId must be a non-empty string");
    }
    return { type: "agent", agentId };
  }
  if (raw.type === "workspace") {
    if (
      Object.keys(raw).some((key) => key !== "type" && key !== "workspaceId") ||
      typeof raw.workspaceId !== "string"
    ) {
      throw new Error("Plugin notification open.workspaceId must be a non-empty string");
    }
    const workspaceId = raw.workspaceId.trim();
    if (!workspaceId) {
      throw new Error("Plugin notification open.workspaceId must be a non-empty string");
    }
    return { type: "workspace", workspaceId };
  }
  if (raw.type === "screen") {
    if (
      Object.keys(raw).some((key) => key !== "type" && key !== "screenId" && key !== "params") ||
      typeof raw.screenId !== "string"
    ) {
      throw new Error("Plugin notification open.screenId must be a non-empty string");
    }
    const screenId = raw.screenId.trim();
    if (!screenId) {
      throw new Error("Plugin notification open.screenId must be a non-empty string");
    }
    if (raw.params === undefined) {
      return { type: "screen", screenId };
    }
    if (!isPlainObject(raw.params)) {
      throw new Error("Plugin notification open.params must be an object of strings");
    }
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.params)) {
      if (!key.trim() || typeof value !== "string") {
        throw new Error("Plugin notification open.params must be an object of strings");
      }
      params[key] = value;
    }
    return { type: "screen", screenId, params };
  }
  throw new Error(`Invalid plugin notification open target type: ${raw.type}`);
}

function validateNotificationKey(raw: unknown): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new Error("Plugin notification key must be a string");
  }
  const trimmedKey = raw.trim();
  if (!trimmedKey || trimmedKey.length > MAX_PLUGIN_NOTIFICATION_KEY_CHARS) {
    throw new Error(
      `Plugin notification key must be 1 to ${MAX_PLUGIN_NOTIFICATION_KEY_CHARS} characters`,
    );
  }
  return trimmedKey;
}

function validateNotificationData(raw: unknown): Record<string, JsonValue> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isPlainObject(raw) || !isJsonValue(raw)) {
    throw new Error("Plugin notification data must be a plain JSON object");
  }
  const serialized = JSON.stringify(raw);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PLUGIN_NOTIFICATION_DATA_BYTES) {
    throw new Error(
      `Plugin notification data must not exceed ${MAX_PLUGIN_NOTIFICATION_DATA_BYTES} UTF-8 bytes`,
    );
  }
  return JSON.parse(serialized) as Record<string, JsonValue>;
}

export function validatePluginNotificationSendInput(
  raw: unknown,
): NormalizedPluginNotificationInput {
  if (!isPlainObject(raw)) {
    throw new Error("Plugin notification input must be an object");
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      throw new Error(`Unknown plugin notification field: ${key}`);
    }
  }
  if (typeof raw.title !== "string" || !raw.title.trim()) {
    throw new Error("Plugin notification title is required");
  }
  const title = raw.title.trim();
  if (title.length > MAX_PLUGIN_NOTIFICATION_TITLE_CHARS) {
    throw new Error(
      `Plugin notification title must not exceed ${MAX_PLUGIN_NOTIFICATION_TITLE_CHARS} characters`,
    );
  }

  if (typeof raw.body !== "string") {
    throw new Error("Plugin notification body must be a string");
  }
  const body = raw.body.trim();
  if (body.length > MAX_PLUGIN_NOTIFICATION_BODY_CHARS) {
    throw new Error(
      `Plugin notification body must not exceed ${MAX_PLUGIN_NOTIFICATION_BODY_CHARS} characters`,
    );
  }

  const key = validateNotificationKey(raw.key);
  const open = raw.open !== undefined ? validateOpenTarget(raw.open) : undefined;
  const data = validateNotificationData(raw.data);

  return {
    title,
    body,
    ...(key !== undefined ? { key } : {}),
    ...(open !== undefined ? { open } : {}),
    ...(data !== undefined ? { data } : {}),
  };
}

export class PluginNotificationDispatcher {
  private readonly dedupByPlugin = new Map<string, Map<string, number>>();
  private readonly bucketsByPlugin = new Map<string, { tokens: number; lastRefillMs: number }>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly deliver: (notification: ValidatedPluginNotification) => void | Promise<void>;

  constructor(options: {
    deliver: (notification: ValidatedPluginNotification) => void | Promise<void>;
    now?: () => number;
    createId?: () => string;
  }) {
    this.deliver = options.deliver;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  async dispatch(pluginId: string, rawInput: unknown): Promise<PluginNotificationSendResult> {
    const input = validatePluginNotificationSendInput(rawInput);
    const nowMs = this.now();

    if (input.key !== undefined) {
      const dedup = this.dedupByPlugin.get(pluginId);
      if (dedup) {
        this.evictExpiredKeys(dedup, nowMs);
        const expiresAt = dedup.get(input.key);
        if (expiresAt !== undefined && expiresAt > nowMs) {
          return { status: "deduplicated" };
        }
      }
    }

    if (!this.tryConsumeToken(pluginId, nowMs)) {
      return { status: "rate_limited" };
    }

    if (input.key !== undefined) {
      let dedup = this.dedupByPlugin.get(pluginId);
      if (!dedup) {
        dedup = new Map();
        this.dedupByPlugin.set(pluginId, dedup);
      } else {
        this.evictExpiredKeys(dedup, nowMs);
      }
      while (dedup.size >= MAX_DEDUP_KEYS_PER_PLUGIN) {
        const oldestKey = dedup.keys().next().value;
        if (oldestKey === undefined) break;
        dedup.delete(oldestKey);
      }
      dedup.set(input.key, nowMs + PLUGIN_NOTIFICATION_DEDUP_WINDOW_MS);
    }

    const notificationId = this.createId();
    await this.deliver({
      pluginId,
      notificationId,
      title: input.title,
      body: input.body,
      ...(input.open ? { open: input.open } : {}),
      ...(input.data ? { data: input.data } : {}),
    });

    return { status: "sent", notificationId };
  }

  clearPlugin(pluginId: string): void {
    this.dedupByPlugin.delete(pluginId);
    this.bucketsByPlugin.delete(pluginId);
  }

  clearAll(): void {
    this.dedupByPlugin.clear();
    this.bucketsByPlugin.clear();
  }

  private evictExpiredKeys(dedup: Map<string, number>, nowMs: number): void {
    for (const [key, expiresAt] of dedup) {
      if (expiresAt <= nowMs) {
        dedup.delete(key);
      }
    }
  }

  private tryConsumeToken(pluginId: string, nowMs: number): boolean {
    let bucket = this.bucketsByPlugin.get(pluginId);
    if (!bucket) {
      bucket = {
        tokens: PLUGIN_NOTIFICATION_BURST_CAPACITY,
        lastRefillMs: nowMs,
      };
      this.bucketsByPlugin.set(pluginId, bucket);
    } else {
      const elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs);
      const refilled = elapsedMs / PLUGIN_NOTIFICATION_REFILL_INTERVAL_MS;
      bucket.tokens = Math.min(PLUGIN_NOTIFICATION_BURST_CAPACITY, bucket.tokens + refilled);
      bucket.lastRefillMs = nowMs;
    }

    if (bucket.tokens < 1) {
      return false;
    }
    bucket.tokens -= 1;
    return true;
  }
}
