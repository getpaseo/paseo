import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import equal from "fast-deep-equal";
import {
  assertDeliveryPayload,
  DeliveryIdSchema,
  DeliveryMessageIdSchema,
  DeliveryPayloadValidationError,
  DeliveryRecordSchema,
  DeliveryStatusSchema,
  DeliveryTargetAgentIdSchema,
  MAX_DELIVERY_PAGE_SIZE,
  MAX_DELIVERY_PAYLOAD_BYTES,
  type DeliveryPayload,
  type DeliveryRecord,
  type DeliveryStatus,
} from "@getpaseo/protocol/deliveries";
import { writeFileAtomic } from "../atomic-file.js";

const LEDGER_VERSION = 1;
const DEFAULT_PAGE_SIZE = MAX_DELIVERY_PAGE_SIZE;
const DEFAULT_MAX_RECORDS_PER_OWNER = 10_000;
const DEFAULT_MAX_BYTES_PER_OWNER = 16 * 1024 * 1024;
const MAX_OWNER_ID_BYTES = 256;
const MAX_ERROR_BYTES = 16 * 1024;

export interface DeliveryLedgerGetOptions {
  deliveryId?: string;
  includeAcknowledged?: boolean;
  cursor?: string;
  limit?: number;
}

export interface DeliveryLedgerSendInput {
  deliveryId?: string;
  targetAgentId?: string;
  messageId?: string;
  payload: DeliveryPayload;
}

export interface DeliveryLedgerSendResult {
  delivery: DeliveryRecord;
  created: boolean;
}

export interface DeliveryLedgerGetResult {
  delivery: DeliveryRecord | null;
  deliveries: DeliveryRecord[];
  nextCursor: string | null;
}

export interface DeliveryLedgerOptions {
  now?: () => Date;
  maxRecordsPerOwner?: number;
  maxBytesPerOwner?: number;
  maxPayloadBytes?: number;
  // Short aliases make the quota seam convenient for focused tests and small
  // embedders without changing the durable format.
  maxDeliveries?: number;
  maxBytes?: number;
}

type DeliveryLedgerErrorCode =
  | "delivery_id_conflict"
  | "delivery_not_found"
  | "delivery_ledger_unavailable"
  | "delivery_quota_exceeded"
  | "delivery_cursor_invalid"
  | "delivery_transition_invalid"
  | "delivery_payload_invalid"
  | "delivery_payload_too_large";

export class DeliveryLedgerError extends Error {
  constructor(
    readonly code: DeliveryLedgerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DeliveryLedgerError";
  }
}

interface OwnerState {
  records: Map<string, DeliveryRecord>;
  loaded: boolean;
  loadPromise: Promise<void> | null;
  mutationTail: Promise<void>;
}

interface PersistedDeliveryLedger {
  version: typeof LEDGER_VERSION;
  ownerId: string;
  deliveries: DeliveryRecord[];
}

function ownerFileName(ownerId: string): string {
  return `${createHash("sha256").update(ownerId).digest("hex")}.json`;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function validateOwnerId(ownerId: string): string {
  if (
    typeof ownerId !== "string" ||
    ownerId.length === 0 ||
    ownerId.length > MAX_OWNER_ID_BYTES ||
    ownerId.trim() !== ownerId ||
    containsControlCharacter(ownerId)
  ) {
    throw new DeliveryLedgerError(
      "delivery_ledger_unavailable",
      "Delivery ledger requires a valid authenticated principal",
    );
  }
  return ownerId;
}

export function deliveryLedgerFilePath(baseDir: string, ownerId: string): string {
  return path.join(baseDir, ownerFileName(validateOwnerId(ownerId)));
}

function clonePayload(payload: DeliveryPayload): DeliveryPayload {
  return JSON.parse(JSON.stringify(payload)) as DeliveryPayload;
}

function cloneDelivery(record: DeliveryRecord): DeliveryRecord {
  return {
    ...record,
    payload: clonePayload(record.payload),
  };
}

function statusOf(record: DeliveryRecord): DeliveryStatus {
  if (record.acknowledgedAt !== null) return "acknowledged";
  return record.status ?? "recorded";
}

function normalizeLoadedRecord(value: unknown): DeliveryRecord {
  const parsed = DeliveryRecordSchema.parse(value);
  const status = statusOf(parsed);
  if (status === "acknowledged" && parsed.acknowledgedAt === null) {
    throw new Error(`Acknowledged delivery ${parsed.deliveryId} has no acknowledgement timestamp`);
  }
  return DeliveryRecordSchema.parse({
    ...parsed,
    messageId: parsed.messageId ?? parsed.deliveryId,
    status,
  });
}

function serializedByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Value is not JSON serializable");
  return Buffer.byteLength(serialized, "utf8");
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return Buffer.from(message, "utf8").subarray(0, MAX_ERROR_BYTES).toString("utf8");
}

function deliveryIdentityMatches(
  existing: DeliveryRecord,
  input: { targetAgentId?: string; messageId?: string; payload: DeliveryPayload },
): boolean {
  if (!equal(existing.payload, input.payload)) return false;
  if (existing.targetAgentId !== input.targetAgentId) return false;
  if (
    input.messageId !== undefined &&
    (existing.messageId ?? existing.deliveryId) !== input.messageId
  ) {
    return false;
  }
  return true;
}

/**
 * Prevents concurrent callers from independently invoking the native agent
 * path for one durable delivery. The server shares one instance across its
 * sessions, so reconnects in the same daemon also remain single-flight.
 */
export class DeliveryDispatchCoordinator {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  run<TResult>(key: string, operation: () => Promise<TResult>): Promise<TResult> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<TResult>;
    const current = Promise.resolve().then(operation);
    this.inFlight.set(key, current);
    void current.then(
      () => {
        if (this.inFlight.get(key) === current) this.inFlight.delete(key);
        return undefined;
      },
      () => {
        if (this.inFlight.get(key) === current) this.inFlight.delete(key);
        return undefined;
      },
    );
    return current;
  }
}

/**
 * Durable, principal-scoped delivery records.
 *
 * The ledger is deliberately a state machine rather than an in-memory queue.
 * Every transition is acknowledged only after its owner file has been
 * atomically replaced. A dispatching record found during a later process start
 * is reconciled to `ambiguous`; the daemon never retries it because the native
 * agent may already have received the message.
 */
export class DeliveryLedger {
  private readonly owners = new Map<string, OwnerState>();
  private readonly now: () => Date;
  private readonly maxRecordsPerOwner: number;
  private readonly maxBytesPerOwner: number;
  private readonly maxPayloadBytes: number;

  constructor(
    private readonly baseDir: string,
    options: DeliveryLedgerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxRecordsPerOwner = positiveInteger(
      options.maxRecordsPerOwner ?? options.maxDeliveries ?? DEFAULT_MAX_RECORDS_PER_OWNER,
      "maxRecordsPerOwner",
    );
    this.maxBytesPerOwner = positiveInteger(
      options.maxBytesPerOwner ?? options.maxBytes ?? DEFAULT_MAX_BYTES_PER_OWNER,
      "maxBytesPerOwner",
    );
    this.maxPayloadBytes = positiveInteger(
      options.maxPayloadBytes ?? MAX_DELIVERY_PAYLOAD_BYTES,
      "maxPayloadBytes",
    );
  }

  async initialize(ownerId = "owner"): Promise<void> {
    await this.ensureLoaded(this.ownerState(ownerId), ownerId);
  }

  async send(ownerId: string, input: DeliveryLedgerSendInput): Promise<DeliveryLedgerSendResult> {
    const normalizedOwnerId = validateOwnerId(ownerId);
    const deliveryId = DeliveryIdSchema.parse(input.deliveryId ?? randomUUID());
    const targetAgentId =
      input.targetAgentId === undefined
        ? undefined
        : DeliveryTargetAgentIdSchema.parse(input.targetAgentId);
    const messageId = DeliveryMessageIdSchema.parse(input.messageId ?? deliveryId);
    try {
      assertDeliveryPayload(input.payload, { maxBytes: this.maxPayloadBytes });
    } catch (error) {
      if (error instanceof DeliveryPayloadValidationError) {
        const code =
          error.reason === "payload_too_large" || error.reason === "string_too_large"
            ? "delivery_payload_too_large"
            : "delivery_payload_invalid";
        throw new DeliveryLedgerError(code, error.message, { cause: error });
      }
      throw error;
    }
    const payload = clonePayload(input.payload);

    return this.enqueue(normalizedOwnerId, async (state) => {
      const existing = state.records.get(deliveryId);
      if (existing) {
        if (!deliveryIdentityMatches(existing, { targetAgentId, messageId, payload })) {
          throw new DeliveryLedgerError(
            "delivery_id_conflict",
            `Delivery ${deliveryId} already exists with a different target, message id, or payload`,
          );
        }
        return { delivery: cloneDelivery(existing), created: false };
      }

      const record = DeliveryRecordSchema.parse({
        deliveryId,
        ...(targetAgentId === undefined ? {} : { targetAgentId }),
        messageId,
        status: "recorded",
        payload,
        createdAt: this.now().toISOString(),
        dispatchingAt: null,
        acceptedAt: null,
        failedAt: null,
        ambiguousAt: null,
        error: null,
        acknowledgedAt: null,
      });
      const nextRecords = new Map(state.records);
      nextRecords.set(deliveryId, record);
      this.assertWithinQuota(nextRecords);
      await this.persist(normalizedOwnerId, nextRecords);
      state.records = nextRecords;
      return { delivery: cloneDelivery(record), created: true };
    });
  }

  async get(
    ownerId: string,
    options: DeliveryLedgerGetOptions = {},
  ): Promise<DeliveryLedgerGetResult> {
    const normalizedOwnerId = validateOwnerId(ownerId);
    const state = this.ownerState(normalizedOwnerId);
    await state.mutationTail;
    await this.ensureLoaded(state, normalizedOwnerId);

    if (options.deliveryId !== undefined) {
      const deliveryId = DeliveryIdSchema.parse(options.deliveryId);
      const delivery = state.records.get(deliveryId);
      return {
        delivery: delivery ? cloneDelivery(delivery) : null,
        deliveries: delivery ? [cloneDelivery(delivery)] : [],
        nextCursor: null,
      };
    }

    const includeAcknowledged = options.includeAcknowledged === true;
    const limit = this.parseLimit(options.limit);
    const records = this.sortedRecords(state.records);
    const cursor = options.cursor !== undefined ? DeliveryIdSchema.parse(options.cursor) : null;
    const cursorIndex =
      cursor === null ? -1 : records.findIndex((record) => record.deliveryId === cursor);
    if (cursor !== null && cursorIndex < 0) {
      throw new DeliveryLedgerError(
        "delivery_cursor_invalid",
        `Delivery cursor ${cursor} is not present in the ledger`,
      );
    }

    const start = cursorIndex + 1;
    const eligible: Array<{ record: DeliveryRecord; index: number }> = [];
    for (let index = start; index < records.length && eligible.length < limit; index += 1) {
      const record = records[index];
      if (!record) continue;
      if (!includeAcknowledged && statusOf(record) === "acknowledged") continue;
      eligible.push({ record, index });
    }
    const last = eligible.at(-1);
    const hasMore = last
      ? records
          .slice(last.index + 1)
          .some((record) => includeAcknowledged || statusOf(record) !== "acknowledged")
      : false;
    return {
      delivery: null,
      deliveries: eligible.map(({ record }) => cloneDelivery(record)),
      nextCursor: hasMore ? (last?.record.deliveryId ?? null) : null,
    };
  }

  async acknowledge(ownerId: string, deliveryId: string): Promise<DeliveryRecord> {
    return this.transition(ownerId, deliveryId, "acknowledged");
  }

  async markDispatching(ownerId: string, deliveryId: string): Promise<DeliveryRecord> {
    return this.transition(ownerId, deliveryId, "dispatching");
  }

  async markAccepted(ownerId: string, deliveryId: string): Promise<DeliveryRecord> {
    return this.transition(ownerId, deliveryId, "accepted");
  }

  async markFailed(ownerId: string, deliveryId: string, error: string): Promise<DeliveryRecord> {
    return this.transition(ownerId, deliveryId, "failed", error);
  }

  async markAmbiguous(ownerId: string, deliveryId: string, error: string): Promise<DeliveryRecord> {
    return this.transition(ownerId, deliveryId, "ambiguous", error);
  }

  /** Public state-machine seam for recovery and focused tests. */
  async transition(
    ownerId: string,
    deliveryId: string,
    status: DeliveryStatus,
    error?: string,
  ): Promise<DeliveryRecord> {
    const normalizedOwnerId = validateOwnerId(ownerId);
    const nextStatus = DeliveryStatusSchema.parse(status);
    const normalizedId = DeliveryIdSchema.parse(deliveryId);
    return this.enqueue(normalizedOwnerId, async (state) => {
      const existing = state.records.get(normalizedId);
      if (!existing) {
        throw new DeliveryLedgerError(
          "delivery_not_found",
          `Delivery ${normalizedId} was not found`,
        );
      }
      const currentStatus = statusOf(existing);
      if (currentStatus === "acknowledged") return cloneDelivery(existing);
      if (currentStatus === nextStatus) return cloneDelivery(existing);
      if (!isAllowedTransition(currentStatus, nextStatus)) {
        throw new DeliveryLedgerError(
          "delivery_transition_invalid",
          `Cannot transition delivery ${normalizedId} from ${currentStatus} to ${nextStatus}`,
        );
      }

      const timestamp = this.now().toISOString();
      const nextRecord = DeliveryRecordSchema.parse({
        ...existing,
        status: nextStatus,
        ...(nextStatus === "dispatching"
          ? { dispatchingAt: existing.dispatchingAt ?? timestamp }
          : {}),
        ...(nextStatus === "accepted"
          ? { acceptedAt: existing.acceptedAt ?? timestamp, error: null }
          : {}),
        ...(nextStatus === "failed"
          ? {
              failedAt: existing.failedAt ?? timestamp,
              error: errorText(error ?? "Delivery failed"),
            }
          : {}),
        ...(nextStatus === "ambiguous"
          ? {
              ambiguousAt: existing.ambiguousAt ?? timestamp,
              error: errorText(
                error ?? "Delivery outcome is ambiguous; it will not be retried automatically",
              ),
            }
          : {}),
        ...(nextStatus === "acknowledged"
          ? { acknowledgedAt: existing.acknowledgedAt ?? timestamp }
          : {}),
      });
      const nextRecords = new Map(state.records);
      nextRecords.set(normalizedId, nextRecord);
      await this.persist(normalizedOwnerId, nextRecords);
      state.records = nextRecords;
      return cloneDelivery(nextRecord);
    });
  }

  /** Reconcile dispatches left in-flight when a previous daemon stopped. */
  async reconcile(ownerId: string): Promise<void> {
    const normalizedOwnerId = validateOwnerId(ownerId);
    await this.enqueue(normalizedOwnerId, async (state) => {
      const nextRecords = new Map(state.records);
      let changed = false;
      for (const [deliveryId, record] of state.records) {
        if (statusOf(record) !== "dispatching") continue;
        nextRecords.set(
          deliveryId,
          DeliveryRecordSchema.parse({
            ...record,
            status: "ambiguous",
            ambiguousAt: record.ambiguousAt ?? this.now().toISOString(),
            error:
              record.error ??
              "Daemon restarted while delivery was dispatching; the outcome is ambiguous and was not retried",
          }),
        );
        changed = true;
      }
      if (changed) {
        await this.persist(normalizedOwnerId, nextRecords);
        state.records = nextRecords;
      }
    });
  }

  /** Remove all state for an installation-scoped principal. */
  async removeOwner(ownerId: string): Promise<void> {
    const normalizedOwnerId = validateOwnerId(ownerId);
    await this.enqueue(normalizedOwnerId, async (state) => {
      try {
        await fs.unlink(deliveryLedgerFilePath(this.baseDir, normalizedOwnerId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new DeliveryLedgerError(
            "delivery_ledger_unavailable",
            `Failed to remove the delivery ledger for ${normalizedOwnerId}`,
            { cause: error },
          );
        }
      }
      state.records = new Map();
    });
  }

  // Alias used by lifecycle owners that call this operation a purge.
  async purgeOwner(ownerId: string): Promise<void> {
    await this.removeOwner(ownerId);
  }

  async flush(): Promise<void> {
    await Promise.all(
      [...this.owners.values()].map(async (state) => {
        await state.mutationTail;
        await state.loadPromise;
      }),
    );
  }

  private ownerState(ownerId: string): OwnerState {
    const normalizedOwnerId = validateOwnerId(ownerId);
    let state = this.owners.get(normalizedOwnerId);
    if (!state) {
      state = {
        records: new Map(),
        loaded: false,
        loadPromise: null,
        mutationTail: Promise.resolve(),
      };
      this.owners.set(normalizedOwnerId, state);
    }
    return state;
  }

  private async ensureLoaded(state: OwnerState, ownerId: string): Promise<void> {
    if (state.loaded) return;
    if (!state.loadPromise) {
      state.loadPromise = this.load(state, ownerId);
    }
    await state.loadPromise;
  }

  private async load(state: OwnerState, ownerId: string): Promise<void> {
    const filePath = deliveryLedgerFilePath(this.baseDir, ownerId);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        state.loaded = true;
        return;
      }
      throw new DeliveryLedgerError(
        "delivery_ledger_unavailable",
        `Failed to read the delivery ledger for ${ownerId}`,
        { cause: error },
      );
    }

    try {
      if (Buffer.byteLength(raw, "utf8") > this.maxBytesPerOwner) {
        throw new DeliveryLedgerError(
          "delivery_quota_exceeded",
          `Delivery ledger for ${ownerId} exceeds its ${this.maxBytesPerOwner}-byte quota`,
        );
      }
      const parsed = JSON.parse(raw) as Partial<PersistedDeliveryLedger>;
      if (
        parsed.version !== LEDGER_VERSION ||
        parsed.ownerId !== ownerId ||
        !Array.isArray(parsed.deliveries)
      ) {
        throw new Error("Unsupported delivery ledger format");
      }
      const records = new Map<string, DeliveryRecord>();
      for (const value of parsed.deliveries) {
        const record = normalizeLoadedRecord(value);
        if (records.has(record.deliveryId)) {
          throw new Error(`Duplicate delivery ${record.deliveryId}`);
        }
        records.set(record.deliveryId, record);
      }
      this.assertWithinQuota(records);

      // A new ledger instance is a process-restart boundary. Do this once on
      // load, not on every get, so a live dispatch is not marked ambiguous by
      // another session in the same daemon.
      const reconciled = this.reconcileRecords(records);
      state.records = reconciled.records;
      if (reconciled.changed) {
        await this.persist(ownerId, reconciled.records);
      }
      state.loaded = true;
    } catch (error) {
      if (error instanceof DeliveryLedgerError) throw error;
      throw new DeliveryLedgerError(
        "delivery_ledger_unavailable",
        `Failed to parse the delivery ledger for ${ownerId}`,
        { cause: error },
      );
    }
  }

  private reconcileRecords(records: Map<string, DeliveryRecord>): {
    records: Map<string, DeliveryRecord>;
    changed: boolean;
  } {
    const nextRecords = new Map(records);
    let changed = false;
    for (const [deliveryId, record] of records) {
      if (statusOf(record) !== "dispatching") continue;
      nextRecords.set(
        deliveryId,
        DeliveryRecordSchema.parse({
          ...record,
          status: "ambiguous",
          ambiguousAt: record.ambiguousAt ?? this.now().toISOString(),
          error:
            record.error ??
            "Daemon restarted while delivery was dispatching; the outcome is ambiguous and was not retried",
        }),
      );
      changed = true;
    }
    return { records: nextRecords, changed };
  }

  private async persist(ownerId: string, records: Map<string, DeliveryRecord>): Promise<void> {
    this.assertWithinQuota(records);
    const value: PersistedDeliveryLedger = {
      version: LEDGER_VERSION,
      ownerId,
      deliveries: [...records.values()].map(cloneDelivery),
    };
    let serialized: string;
    try {
      serialized = JSON.stringify(value, null, 2);
      if (Buffer.byteLength(serialized, "utf8") > this.maxBytesPerOwner) {
        throw new DeliveryLedgerError(
          "delivery_quota_exceeded",
          `Delivery ledger for ${ownerId} exceeds its ${this.maxBytesPerOwner}-byte quota`,
        );
      }
      await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
      await fs.chmod(this.baseDir, 0o700);
      await writeFileAtomic(deliveryLedgerFilePath(this.baseDir, ownerId), serialized, {
        mode: 0o600,
      });
      await fs.chmod(deliveryLedgerFilePath(this.baseDir, ownerId), 0o600);
    } catch (error) {
      if (error instanceof DeliveryLedgerError) throw error;
      throw new DeliveryLedgerError(
        "delivery_ledger_unavailable",
        `Failed to persist the delivery ledger for ${ownerId}`,
        { cause: error },
      );
    }
  }

  private assertWithinQuota(records: Map<string, DeliveryRecord>): void {
    if (records.size > this.maxRecordsPerOwner) {
      throw new DeliveryLedgerError(
        "delivery_quota_exceeded",
        `Delivery principal exceeds its ${this.maxRecordsPerOwner}-record quota`,
      );
    }
    let bytes = 0;
    for (const record of records.values()) bytes += serializedByteLength(record);
    if (bytes > this.maxBytesPerOwner) {
      throw new DeliveryLedgerError(
        "delivery_quota_exceeded",
        `Delivery principal exceeds its ${this.maxBytesPerOwner}-byte quota`,
      );
    }
  }

  private parseLimit(limit: number | undefined): number {
    const resolved = limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(resolved) || resolved < 1 || resolved > MAX_DELIVERY_PAGE_SIZE) {
      throw new DeliveryLedgerError(
        "delivery_quota_exceeded",
        `Delivery page size must be between 1 and ${MAX_DELIVERY_PAGE_SIZE}`,
      );
    }
    return resolved;
  }

  private sortedRecords(records: Map<string, DeliveryRecord>): DeliveryRecord[] {
    return [...records.values()].sort((left, right) => {
      const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
      return byCreatedAt !== 0 ? byCreatedAt : left.deliveryId.localeCompare(right.deliveryId);
    });
  }

  private enqueue<TResult>(
    ownerId: string,
    operation: (state: OwnerState) => Promise<TResult>,
  ): Promise<TResult> {
    const state = this.ownerState(ownerId);
    const next = state.mutationTail
      .catch(() => undefined)
      .then(async () => {
        await this.ensureLoaded(state, ownerId);
        return operation(state);
      });
    state.mutationTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function isAllowedTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  if (from === "recorded") return to === "dispatching" || to === "acknowledged";
  if (from === "dispatching") {
    return to === "accepted" || to === "failed" || to === "ambiguous" || to === "acknowledged";
  }
  if (from === "accepted" || from === "failed" || from === "ambiguous") {
    return to === "acknowledged";
  }
  return false;
}
