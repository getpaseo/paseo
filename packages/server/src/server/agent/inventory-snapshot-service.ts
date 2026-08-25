import { createHash, createHmac, randomBytes } from "node:crypto";

export const INVENTORY_SCHEMA_VERSION = "paseo.inventory_sessions.v1";
const DEFAULT_PAGE_LIMIT = 200;
const MAX_PAGE_LIMIT = 200;
const DEFAULT_SNAPSHOT_TTL_MS = 10 * 60 * 1000;
export const MAX_SNAPSHOTS_PER_DAEMON = 64;

export interface InventorySessionEntry {
  backend: "paseo";
  native_id: string;
  provider: string;
  status_raw: string;
  archived: boolean;
  archived_at: string | null;
  internal: boolean;
  /** True only when status_raw came from the live AgentManager map. */
  live: boolean;
  cwd: string;
  created_at: string;
  updated_at: string;
  persistence_session_id: string | null;
}

export interface InventorySnapshotPage {
  schema_version: typeof INVENTORY_SCHEMA_VERSION;
  snapshot_id: string;
  entries: InventorySessionEntry[];
  next_cursor: string | null;
  has_more: boolean;
}

export class InventorySnapshotError extends Error {
  constructor(
    readonly code:
      | "invalid_inventory_cursor"
      | "inventory_snapshot_expired"
      | "inventory_snapshot_not_found"
      | "inventory_snapshot_conflict",
    message: string,
  ) {
    super(message);
    this.name = "InventorySnapshotError";
  }
}

interface FrozenInventorySnapshot {
  entries: InventorySessionEntry[];
  expiresAt: number;
}

interface CursorPayload {
  snapshot_id: string;
  offset: number;
  proof: string;
}

export interface InventorySnapshotRequest {
  snapshot_id?: string;
  cursor?: string;
  limit?: number;
}

export interface InventorySnapshotServiceOptions {
  now?: () => number;
  ttlMs?: number;
  maxSnapshots?: number;
}

/**
 * A daemon-local, immutable materialization of the Paseo registry inventory.
 *
 * The snapshot id is SHA-256 over canonical JSON. A cursor is HMAC-bound to
 * that id and absolute offset. Entries are cloned before storage, and the
 * bounded LRU cache is shared by all sessions in one daemon when injected by
 * WebSocketServer.
 */
export class InventorySnapshotService {
  private readonly snapshots = new Map<string, FrozenInventorySnapshot>();
  private readonly expiredSnapshots = new Set<string>();
  private readonly cursorSecret = randomBytes(32).toString("base64url");
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxSnapshots: number;

  constructor(
    private readonly captureEntries: () =>
      | InventorySessionEntry[]
      | Promise<InventorySessionEntry[]>,
    options: InventorySnapshotServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
    this.maxSnapshots = options.maxSnapshots ?? MAX_SNAPSHOTS_PER_DAEMON;
    if (!Number.isInteger(this.maxSnapshots) || this.maxSnapshots <= 0) {
      throw new Error("maxSnapshots must be a positive integer");
    }
  }

  async page(request: InventorySnapshotRequest, clientId: string): Promise<InventorySnapshotPage> {
    this.removeExpiredSnapshots();
    const limit = this.normalizeLimit(request.limit);
    const hasSnapshotId = request.snapshot_id !== undefined;
    const hasCursor = request.cursor !== undefined;
    if (hasSnapshotId !== hasCursor) {
      throw new InventorySnapshotError(
        "invalid_inventory_cursor",
        "inventory snapshot_id and cursor must be supplied together after the first page",
      );
    }

    if (!hasSnapshotId) {
      const entries = this.freezeAndValidate(await this.captureEntries());
      const snapshotId = this.snapshotId(entries);
      if (entries.length > limit) {
        this.storeSnapshot(snapshotId, clientId, entries);
      }
      return this.buildPage(snapshotId, entries, 0, limit, clientId);
    }

    const snapshotId = request.snapshot_id!;
    const cursor = this.decodeCursor(request.cursor!);
    if (cursor.snapshot_id !== snapshotId) {
      throw new InventorySnapshotError(
        "invalid_inventory_cursor",
        "inventory cursor belongs to a different snapshot_id",
      );
    }

    const snapshotKey = this.snapshotKey(snapshotId, clientId);
    const snapshot = this.snapshots.get(snapshotKey);
    if (!snapshot) {
      if (this.expiredSnapshots.has(snapshotKey)) {
        throw new InventorySnapshotError(
          "inventory_snapshot_expired",
          "inventory snapshot has expired",
        );
      }
      throw new InventorySnapshotError(
        "inventory_snapshot_not_found",
        "inventory snapshot is unknown, evicted, or owned by another client",
      );
    }
    if (cursor.proof !== this.cursorProof(cursor.snapshot_id, cursor.offset, clientId)) {
      throw new InventorySnapshotError("invalid_inventory_cursor", "inventory cursor is invalid");
    }
    if (snapshot.expiresAt <= this.now()) {
      this.expireSnapshot(snapshotKey);
      throw new InventorySnapshotError(
        "inventory_snapshot_expired",
        "inventory snapshot has expired",
      );
    }
    if (cursor.offset <= 0 || cursor.offset >= snapshot.entries.length) {
      throw new InventorySnapshotError(
        "invalid_inventory_cursor",
        "inventory cursor offset is invalid",
      );
    }
    this.touchSnapshot(snapshotKey, snapshot);
    return this.buildPage(snapshotId, snapshot.entries, cursor.offset, limit, clientId);
  }

  private normalizeLimit(limit: number | undefined): number {
    if (limit === undefined) return DEFAULT_PAGE_LIMIT;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_PAGE_LIMIT) {
      throw new InventorySnapshotError(
        "invalid_inventory_cursor",
        `inventory page limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`,
      );
    }
    return limit;
  }

  private buildPage(
    snapshotId: string,
    entries: InventorySessionEntry[],
    offset: number,
    limit: number,
    clientId: string,
  ): InventorySnapshotPage {
    const pageEntries = entries.slice(offset, offset + limit);
    const nextOffset = offset + pageEntries.length;
    const hasMore = nextOffset < entries.length;
    return {
      schema_version: INVENTORY_SCHEMA_VERSION,
      snapshot_id: snapshotId,
      entries: structuredClone(pageEntries),
      next_cursor: hasMore ? this.encodeCursor(snapshotId, nextOffset, clientId) : null,
      has_more: hasMore,
    };
  }

  private freezeAndValidate(entries: InventorySessionEntry[]): InventorySessionEntry[] {
    const byIdentity = new Set<string>();
    const frozen = entries.map((entry) => structuredClone(entry)).sort(compareInventoryIdentity);
    for (const entry of frozen) {
      if (
        !entry.native_id ||
        !entry.provider ||
        !entry.status_raw ||
        Number.isNaN(Date.parse(entry.created_at)) ||
        Number.isNaN(Date.parse(entry.updated_at))
      ) {
        throw new InventorySnapshotError(
          "inventory_snapshot_conflict",
          "inventory source returned a malformed session entry",
        );
      }
      const identity = `${entry.backend}\u0000${entry.native_id}`;
      if (byIdentity.has(identity)) {
        throw new InventorySnapshotError(
          "inventory_snapshot_conflict",
          `duplicate canonical inventory identity: ${entry.backend}/${entry.native_id}`,
        );
      }
      byIdentity.add(identity);
    }
    return frozen;
  }

  private snapshotId(entries: InventorySessionEntry[]): string {
    const canonical = canonicalStringify({ schema_version: INVENTORY_SCHEMA_VERSION, entries });
    return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  }

  private storeSnapshot(
    snapshotId: string,
    clientId: string,
    entries: InventorySessionEntry[],
  ): void {
    const key = this.snapshotKey(snapshotId, clientId);
    this.snapshots.delete(key);
    this.expiredSnapshots.delete(key);
    while (this.snapshots.size >= this.maxSnapshots) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest === undefined) break;
      this.snapshots.delete(oldest);
    }
    this.snapshots.set(key, { entries, expiresAt: this.now() + this.ttlMs });
  }

  private touchSnapshot(key: string, snapshot: FrozenInventorySnapshot): void {
    this.snapshots.delete(key);
    this.snapshots.set(key, snapshot);
  }

  private snapshotKey(snapshotId: string, clientId: string): string {
    return `${clientId}\u0000${snapshotId}`;
  }

  private encodeCursor(snapshotId: string, offset: number, clientId: string): string {
    const proof = this.cursorProof(snapshotId, offset, clientId);
    return Buffer.from(JSON.stringify({ snapshot_id: snapshotId, offset, proof })).toString(
      "base64url",
    );
  }

  private decodeCursor(cursor: string): CursorPayload {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
        throw new Error("invalid base64url alphabet");
      }
      const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as CursorPayload).snapshot_id !== "string" ||
        !Number.isInteger((parsed as CursorPayload).offset) ||
        typeof (parsed as CursorPayload).proof !== "string"
      ) {
        throw new Error("invalid shape");
      }
      const payload = parsed as CursorPayload;
      const canonical = Buffer.from(JSON.stringify(payload)).toString("base64url");
      if (canonical !== cursor) {
        throw new Error("non-canonical cursor");
      }
      return payload;
    } catch {
      throw new InventorySnapshotError("invalid_inventory_cursor", "inventory cursor is invalid");
    }
  }

  private cursorProof(snapshotId: string, offset: number, clientId: string): string {
    return createHmac("sha256", this.cursorSecret)
      .update(`${snapshotId}\u0000${offset}\u0000${clientId}`)
      .digest("base64url");
  }

  private removeExpiredSnapshots(): void {
    const now = this.now();
    for (const [snapshotKey, snapshot] of this.snapshots) {
      if (snapshot.expiresAt <= now) {
        this.expireSnapshot(snapshotKey);
      }
    }
  }

  private expireSnapshot(snapshotKey: string): void {
    this.snapshots.delete(snapshotKey);
    this.expiredSnapshots.delete(snapshotKey);
    this.expiredSnapshots.add(snapshotKey);
    while (this.expiredSnapshots.size > this.maxSnapshots) {
      const oldest = this.expiredSnapshots.values().next().value;
      if (oldest === undefined) break;
      this.expiredSnapshots.delete(oldest);
    }
  }
}

function compareInventoryIdentity(
  left: InventorySessionEntry,
  right: InventorySessionEntry,
): number {
  const backendOrder = compareCodeUnits(left.backend, right.backend);
  if (backendOrder !== 0) return backendOrder;
  const nativeIdOrder = compareCodeUnits(left.native_id, right.native_id);
  if (nativeIdOrder !== 0) return nativeIdOrder;
  return 0;
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InventorySnapshotError("inventory_snapshot_conflict", "non-finite inventory value");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareCodeUnits);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`).join(",")}}`;
  }
  throw new InventorySnapshotError("inventory_snapshot_conflict", "unsupported inventory value");
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
