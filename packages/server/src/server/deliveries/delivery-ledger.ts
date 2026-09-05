import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import equal from "fast-deep-equal";
import {
  assertDeliveryPayload,
  DeliveryCursorSchema,
  DeliveryIdSchema,
  DeliveryMessageIdSchema,
  DeliveryPayloadValidationError,
  DeliveryRecordSchema,
  DeliverySequenceCursorSchema,
  DeliveryStatusSchema,
  DeliveryTargetAgentIdSchema,
  MAX_DELIVERY_PAGE_SIZE,
  MAX_DELIVERY_PAYLOAD_BYTES,
  MAX_DELIVERY_RESPONSE_BYTES,
  MAX_WEBSOCKET_MESSAGE_BYTES,
  type DeliveryPayload,
  type DeliveryRecord,
  type DeliveryStatus,
} from "@getpaseo/protocol/deliveries";

const LEDGER_VERSION = 2;
const LEGACY_LEDGER_VERSION = 1;
const DEFAULT_PAGE_SIZE = MAX_DELIVERY_PAGE_SIZE;
const DEFAULT_MAX_RECORDS_PER_OWNER = 10_000;
const DEFAULT_MAX_BYTES_PER_OWNER = 16 * 1024 * 1024;
const DEFAULT_MAX_LEDGER_BYTES = 64 * 1024 * 1024;
const DEFAULT_ACKNOWLEDGED_PAYLOAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ACKNOWLEDGED_PAYLOADS = 1_000;
const DEFAULT_MAX_ACKNOWLEDGED_PAYLOAD_BYTES = 4 * 1024 * 1024;
const DEFAULT_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_OWNER_ID_BYTES = 256;
const MAX_ERROR_BYTES = 16 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const TRANSIENT_RETRY_COUNT = 3;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
// A zero fallback silently turns every guarded open into a symlink-following
// open on platforms without O_NOFOLLOW. Delivery persistence is fail-closed.
const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
const O_DIRECTORY = (fsConstants as { O_DIRECTORY?: number }).O_DIRECTORY ?? 0;

export interface DeliveryLedgerGetOptions {
  deliveryId?: string;
  includeAcknowledged?: boolean;
  /** New cursors are sequence strings. Legacy numeric sequence cursors remain readable. */
  cursor?: string;
  limit?: number;
  /** Used by the session layer to budget the complete encoded WS envelope. */
  responseRequestId?: string;
  maxEncodedBytes?: number;
  /** Only a client advertising deliveryPayloadTombstones may see compacted rows. */
  allowPayloadTombstones?: boolean;
  /** Exact target fence used by caller-scoped host delivery access. */
  targetAgentId?: string;
  /** Internal cancellation fence for host operations. */
  signal?: AbortSignal;
}

export interface DeliveryLedgerSendInput {
  deliveryId?: string;
  targetAgentId?: string;
  messageId?: string;
  payload: DeliveryPayload;
  /** Set only when the admitting client negotiated payload tombstones. */
  payloadTombstoneEligible?: boolean;
  /** Internal cancellation fence for host operations. */
  signal?: AbortSignal;
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

export interface DeliveryLedgerDiagnostic {
  kind: "quarantined" | "cleanup_timeout";
  ownerId: string;
  filePath: string;
  quarantinePath: string;
  reason: string;
  operation?: "flush" | "removeOwner";
  timeoutMs?: number;
}

export interface DeliveryLedgerOptions {
  now?: () => Date;
  maxRecordsPerOwner?: number;
  maxBytesPerOwner?: number;
  maxPayloadBytes?: number;
  maxLedgerBytes?: number;
  acknowledgedPayloadMaxAgeMs?: number;
  maxAcknowledgedPayloads?: number;
  maxAcknowledgedPayloadBytes?: number;
  tombstoneRetentionMs?: number;
  cleanupTimeoutMs?: number;
  onDiagnostic?: (diagnostic: DeliveryLedgerDiagnostic) => void;
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
  | "delivery_payload_too_large"
  | "delivery_payload_unavailable"
  | "delivery_target_required"
  | "delivery_owner_closing"
  | "delivery_response_too_large"
  | "delivery_target_mismatch"
  | "delivery_cleanup_timeout";

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

type LedgerRecord = DeliveryRecord & {
  sequence: number;
  payloadFingerprint: string;
  status: DeliveryStatus;
};

interface OwnerState {
  records: Map<string, LedgerRecord>;
  nextSequence: number;
  loaded: boolean;
  loadPromise: Promise<void> | null;
  mutationTail: Promise<void>;
  closing: boolean;
  /** Once purged, this in-process identity can never be reopened. */
  retired: boolean;
}

interface PersistedDeliveryLedger {
  version: typeof LEDGER_VERSION;
  ownerId: string;
  nextSequence: number;
  deliveries: DeliveryRecord[];
}

interface ParsedLedgerEnvelope {
  version: number;
  ownerId: string;
  nextSequence?: number;
  deliveries: unknown[];
}

interface LoadedLedgerContents {
  records: Map<string, LedgerRecord>;
  nextSequence: number;
  needsPersist: boolean;
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

function clonePayload(payload: DeliveryPayload | undefined): DeliveryPayload | undefined {
  return payload === undefined
    ? undefined
    : (JSON.parse(JSON.stringify(payload)) as DeliveryPayload);
}

function cloneDelivery(record: DeliveryRecord): DeliveryRecord {
  const cloned = { ...record } as DeliveryRecord;
  if (record.payload === undefined) delete cloned.payload;
  else cloned.payload = clonePayload(record.payload);
  return cloned;
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error(message);
}

/** Rehydrate only the response copy for an idempotent retry of a tombstone. */
function cloneDeliveryForResend(record: LedgerRecord, payload: DeliveryPayload): DeliveryRecord {
  const cloned = cloneDelivery(record);
  if (cloned.payload === undefined) cloned.payload = clonePayload(payload);
  return cloned;
}

function statusOf(record: DeliveryRecord): DeliveryStatus {
  if (record.acknowledgedAt !== null) return "acknowledged";
  return record.status ?? "recorded";
}

function stableSerialize(value: DeliveryPayload): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key] as DeliveryPayload)}`)
    .join(",")}}`;
}

function payloadFingerprint(payload: DeliveryPayload): string {
  return createHash("sha256").update(stableSerialize(payload), "utf8").digest("hex");
}

interface LoadedRecordOptions {
  sequence?: number;
  allowLegacyPull: boolean;
  maxPayloadBytes: number;
}

function assertLoadedRecordIdentity(
  parsed: DeliveryRecord,
  status: DeliveryStatus,
  legacyPull: boolean,
): void {
  if (status === "acknowledged" && parsed.acknowledgedAt === null) {
    throw new Error(`Acknowledged delivery ${parsed.deliveryId} has no acknowledgement timestamp`);
  }
  // COMPAT(durableDeliveryTarget): added in v0.7.2; remove after 2027-03-31 once client floor >= v0.7.2 and daemon floor >= v0.7.2.
  if (parsed.targetAgentId === undefined && !legacyPull) {
    throw new Error(`Delivery ${parsed.deliveryId} has no target agent`);
  }
  if (parsed.targetAgentId !== undefined && parsed.deliveryMode === "legacy_pull") {
    throw new Error(`Targeted delivery ${parsed.deliveryId} cannot be legacy pull state`);
  }
}

function assertLoadedRecordPayload(
  parsed: DeliveryRecord,
  status: DeliveryStatus,
  maxPayloadBytes: number,
): void {
  if (parsed.payload === undefined && !parsed.payloadFingerprint) {
    throw new Error(`Tombstone ${parsed.deliveryId} has no payload fingerprint`);
  }
  if (parsed.payload === undefined && status !== "acknowledged") {
    throw new Error(`Pending delivery ${parsed.deliveryId} has no payload`);
  }
  if (parsed.payload !== undefined) {
    assertDeliveryPayload(parsed.payload, { maxBytes: maxPayloadBytes });
    const recomputedFingerprint = payloadFingerprint(parsed.payload);
    if (
      parsed.payloadFingerprint !== undefined &&
      parsed.payloadFingerprint !== recomputedFingerprint
    ) {
      throw new Error(`Delivery ${parsed.deliveryId} has a mismatched payload fingerprint`);
    }
  }
}

function acceptedAtForLoadedRecord(
  parsed: DeliveryRecord,
  status: DeliveryStatus,
  legacyPull: boolean,
): string | null {
  if (legacyPull && status === "accepted") return parsed.acceptedAt ?? parsed.createdAt;
  return parsed.acceptedAt ?? null;
}

function normalizedLoadedRecordInput(
  parsed: DeliveryRecord,
  sequence: number | undefined,
  status: DeliveryStatus,
  legacyPull: boolean,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    deliveryId: parsed.deliveryId,
    deliveryMode: legacyPull ? "legacy_pull" : "targeted",
    sequence: parsed.sequence ?? sequence,
    messageId: parsed.messageId ?? parsed.deliveryId,
    status,
    createdAt: parsed.createdAt,
    dispatchingAt: parsed.dispatchingAt ?? null,
    acceptedAt: acceptedAtForLoadedRecord(parsed, status, legacyPull),
    failedAt: parsed.failedAt ?? null,
    ambiguousAt: parsed.ambiguousAt ?? null,
    error: parsed.error ?? null,
    acknowledgedAt: parsed.acknowledgedAt,
  };
  if (parsed.targetAgentId !== undefined) normalized.targetAgentId = parsed.targetAgentId;
  if (parsed.payload !== undefined) normalized.payload = parsed.payload;
  if (parsed.payloadFingerprint !== undefined) {
    normalized.payloadFingerprint = parsed.payloadFingerprint;
  } else if (parsed.payload !== undefined) {
    normalized.payloadFingerprint = payloadFingerprint(parsed.payload);
  }
  if (!legacyPull && parsed.payloadTombstoneEligible === true) {
    normalized.payloadTombstoneEligible = true;
  }
  return normalized;
}

function normalizeLoadedRecord(value: unknown, options: LoadedRecordOptions): LedgerRecord {
  const parsed = DeliveryRecordSchema.parse(value);
  // COMPAT(durableDeliveryTarget): added in v0.7.2; remove after 2027-03-31 once client floor >= v0.7.2 and daemon floor >= v0.7.2.
  const legacyPull =
    parsed.targetAgentId === undefined &&
    (parsed.deliveryMode === "legacy_pull" || options.allowLegacyPull);
  const status = legacyPull && statusOf(parsed) !== "acknowledged" ? "accepted" : statusOf(parsed);
  assertLoadedRecordIdentity(parsed, status, legacyPull);
  assertLoadedRecordPayload(parsed, status, options.maxPayloadBytes);
  const normalized = DeliveryRecordSchema.parse(
    normalizedLoadedRecordInput(parsed, options.sequence, status, legacyPull),
  );
  if (
    typeof normalized.sequence !== "number" ||
    !Number.isSafeInteger(normalized.sequence) ||
    normalized.sequence < 1 ||
    typeof normalized.payloadFingerprint !== "string"
  ) {
    throw new Error(`Delivery ${normalized.deliveryId} has invalid durable identity`);
  }
  return normalized as LedgerRecord;
}

function hasDurableSequence(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { sequence?: unknown }).sequence === "number"
  );
}

function compareLegacyDeliveries(left: unknown, right: unknown): number {
  const leftRecord = DeliveryRecordSchema.parse(left);
  const rightRecord = DeliveryRecordSchema.parse(right);
  const byCreatedAt = leftRecord.createdAt.localeCompare(rightRecord.createdAt);
  return byCreatedAt !== 0
    ? byCreatedAt
    : leftRecord.deliveryId.localeCompare(rightRecord.deliveryId);
}

function normalizeLedgerRecords(
  values: unknown[],
  migrateSequence: boolean,
  allowLegacyPull: boolean,
  maxPayloadBytes: number,
): Map<string, LedgerRecord> {
  const records = new Map<string, LedgerRecord>();
  const sequences = new Set<number>();
  for (const [index, value] of values.entries()) {
    const record = normalizeLoadedRecord(value, {
      sequence: migrateSequence ? index + 1 : undefined,
      allowLegacyPull,
      maxPayloadBytes,
    });
    if (records.has(record.deliveryId)) throw new Error(`Duplicate delivery ${record.deliveryId}`);
    if (sequences.has(record.sequence)) {
      throw new Error(`Duplicate delivery sequence ${record.sequence}`);
    }
    records.set(record.deliveryId, record);
    sequences.add(record.sequence);
  }
  return records;
}

function resolveNextSequence(parsed: ParsedLedgerEnvelope, maximumSequence: number): number {
  const persistedNextSequence = parsed.version === LEDGER_VERSION ? parsed.nextSequence : undefined;
  const nextSequence =
    typeof persistedNextSequence === "number" &&
    Number.isSafeInteger(persistedNextSequence) &&
    persistedNextSequence > maximumSequence
      ? persistedNextSequence
      : maximumSequence + 1;
  if (!Number.isSafeInteger(nextSequence)) throw new Error("Delivery sequence exhausted");
  return nextSequence;
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
  existing: LedgerRecord,
  input: {
    targetAgentId?: string;
    messageId?: string;
    payload: DeliveryPayload;
    fingerprint: string;
  },
): boolean {
  if (existing.payload !== undefined && !equal(existing.payload, input.payload)) return false;
  if (existing.payloadFingerprint !== input.fingerprint) return false;
  if (existing.targetAgentId !== input.targetAgentId) return false;
  if (
    input.messageId !== undefined &&
    (existing.messageId ?? existing.deliveryId) !== input.messageId
  ) {
    return false;
  }
  return true;
}

function isVisibleDelivery(
  record: LedgerRecord | undefined,
  includeAcknowledged: boolean,
  allowPayloadTombstones: boolean,
  targetAgentId?: string,
): record is LedgerRecord {
  return (
    record !== undefined &&
    (targetAgentId === undefined || record.targetAgentId === targetAgentId) &&
    (includeAcknowledged || statusOf(record) !== "acknowledged") &&
    (record.payload !== undefined || allowPayloadTombstones)
  );
}

function hasVisibleDeliveryAfter(
  records: LedgerRecord[],
  startIndex: number,
  includeAcknowledged: boolean,
  allowPayloadTombstones: boolean,
  targetAgentId?: string,
): boolean {
  return records
    .slice(startIndex + 1)
    .some((record) =>
      isVisibleDelivery(record, includeAcknowledged, allowPayloadTombstones, targetAgentId),
    );
}

function isTransientFsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EAGAIN" || code === "EINTR" || code === "EMFILE" || code === "ENFILE";
}

async function withTransientRetry<T>(operation: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      attempt += 1;
      if (!isTransientFsError(error) || attempt >= TRANSIENT_RETRY_COUNT) throw error;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

function sameFile(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function noFollowFlag(): number {
  if (typeof O_NOFOLLOW !== "number" || O_NOFOLLOW <= 0) {
    throw new DeliveryLedgerError(
      "delivery_ledger_unavailable",
      "Delivery persistence requires platform O_NOFOLLOW support",
    );
  }
  return O_NOFOLLOW;
}

/** Serialize native delivery attempts and fence an owner during teardown. */
export class DeliveryDispatchCoordinator {
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly owners = new Map<string, Set<Promise<unknown>>>();
  private readonly closingOwners = new Set<string>();

  run<TResult>(key: string, operation: () => Promise<TResult>, ownerId?: string): Promise<TResult> {
    if (ownerId && this.closingOwners.has(ownerId)) {
      return Promise.reject(
        new DeliveryLedgerError("delivery_owner_closing", `Delivery owner ${ownerId} is closing`),
      );
    }
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<TResult>;
    const current = Promise.resolve().then(operation);
    this.inFlight.set(key, current);
    if (ownerId) {
      const ownerOperations = this.owners.get(ownerId) ?? new Set<Promise<unknown>>();
      ownerOperations.add(current);
      this.owners.set(ownerId, ownerOperations);
      void current.then(
        () => {
          ownerOperations.delete(current);
          if (ownerOperations.size === 0) this.owners.delete(ownerId);
          return undefined;
        },
        () => {
          ownerOperations.delete(current);
          if (ownerOperations.size === 0) this.owners.delete(ownerId);
          return undefined;
        },
      );
    }
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

  beginOwnerClosing(ownerId: string): void {
    this.closingOwners.add(ownerId);
  }

  isOwnerClosing(ownerId: string): boolean {
    return this.closingOwners.has(ownerId);
  }

  async waitForOwner(ownerId: string, timeoutMs: number): Promise<boolean> {
    const pending = [...(this.owners.get(ownerId) ?? [])];
    if (pending.length === 0) return true;
    return Promise.race([
      Promise.allSettled(pending).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  async waitForOwnerSettled(ownerId: string): Promise<void> {
    while (true) {
      const pending = [...(this.owners.get(ownerId) ?? [])];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  finishOwner(ownerId: string): void {
    // Owner identities are installation identities. Once closed, a late
    // dispatch must remain fenced for the life of this coordinator.
    this.closingOwners.add(ownerId);
  }
}

/** Durable principal-scoped delivery records and their lifecycle state. */
export class DeliveryLedger {
  private readonly owners = new Map<string, OwnerState>();
  private readonly now: () => Date;
  private readonly maxRecordsPerOwner: number;
  private readonly maxBytesPerOwner: number;
  private readonly maxPayloadBytes: number;
  private readonly maxLedgerBytes: number;
  private readonly acknowledgedPayloadMaxAgeMs: number;
  private readonly maxAcknowledgedPayloads: number;
  private readonly maxAcknowledgedPayloadBytes: number;
  private readonly tombstoneRetentionMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly onDiagnostic: ((diagnostic: DeliveryLedgerDiagnostic) => void) | null;

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
    this.maxLedgerBytes = positiveInteger(
      options.maxLedgerBytes ?? DEFAULT_MAX_LEDGER_BYTES,
      "maxLedgerBytes",
    );
    this.acknowledgedPayloadMaxAgeMs = nonNegativeInteger(
      options.acknowledgedPayloadMaxAgeMs ?? DEFAULT_ACKNOWLEDGED_PAYLOAD_MAX_AGE_MS,
      "acknowledgedPayloadMaxAgeMs",
    );
    this.maxAcknowledgedPayloads = nonNegativeInteger(
      options.maxAcknowledgedPayloads ?? DEFAULT_MAX_ACKNOWLEDGED_PAYLOADS,
      "maxAcknowledgedPayloads",
    );
    this.maxAcknowledgedPayloadBytes = nonNegativeInteger(
      options.maxAcknowledgedPayloadBytes ?? DEFAULT_MAX_ACKNOWLEDGED_PAYLOAD_BYTES,
      "maxAcknowledgedPayloadBytes",
    );
    this.tombstoneRetentionMs = nonNegativeInteger(
      options.tombstoneRetentionMs ?? DEFAULT_TOMBSTONE_RETENTION_MS,
      "tombstoneRetentionMs",
    );
    this.cleanupTimeoutMs = positiveInteger(
      options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
      "cleanupTimeoutMs",
    );
    this.onDiagnostic = options.onDiagnostic ?? null;
  }

  async initialize(ownerId = "owner"): Promise<void> {
    await this.ensureLoaded(this.ownerState(ownerId), validateOwnerId(ownerId));
  }

  beginOwnerClosing(ownerId: string): void {
    this.ownerState(ownerId).closing = true;
  }

  isOwnerClosing(ownerId: string): boolean {
    return this.ownerState(ownerId).closing;
  }

  async waitForOwnerIdle(ownerId: string): Promise<void> {
    const state = this.ownerState(ownerId);
    await Promise.allSettled([
      state.mutationTail,
      ...(state.loadPromise ? [state.loadPromise] : []),
    ]);
  }

  async send(ownerId: string, input: DeliveryLedgerSendInput): Promise<DeliveryLedgerSendResult> {
    const normalizedOwnerId = validateOwnerId(ownerId);
    this.assertOwnerOpen(this.ownerState(normalizedOwnerId), normalizedOwnerId);
    throwIfAborted(input.signal, "Delivery send cancelled");
    const deliveryId = DeliveryIdSchema.parse(input.deliveryId ?? randomUUID());
    const targetAgentId =
      input.targetAgentId === undefined
        ? undefined
        : DeliveryTargetAgentIdSchema.parse(input.targetAgentId);
    const legacyPull = targetAgentId === undefined;
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
    const payload = clonePayload(input.payload) as DeliveryPayload;
    const fingerprint = payloadFingerprint(payload);

    return this.enqueue(normalizedOwnerId, async (state) => {
      throwIfAborted(input.signal, "Delivery send cancelled");
      this.assertOwnerOpen(state, normalizedOwnerId);
      const compacted = this.compactAcknowledged(
        state.records,
        input.payloadTombstoneEligible === true,
      );
      if (compacted.changed) {
        throwIfAborted(input.signal, "Delivery send cancelled");
        await this.persist(normalizedOwnerId, compacted.records, state.nextSequence);
        state.records = compacted.records;
      }
      const existing = state.records.get(deliveryId);
      if (existing) {
        if (
          !deliveryIdentityMatches(existing, { targetAgentId, messageId, payload, fingerprint })
        ) {
          throw new DeliveryLedgerError(
            "delivery_id_conflict",
            `Delivery ${deliveryId} already exists with a different target, message id, or payload`,
          );
        }
        return {
          delivery: cloneDeliveryForResend(existing, payload),
          created: false,
        };
      }

      const createdAt = this.now().toISOString();
      const record = DeliveryRecordSchema.parse({
        deliveryId,
        sequence: state.nextSequence,
        ...(targetAgentId === undefined ? {} : { targetAgentId }),
        messageId,
        status: legacyPull ? "accepted" : "recorded",
        deliveryMode: legacyPull ? "legacy_pull" : "targeted",
        ...(input.payloadTombstoneEligible === true && !legacyPull
          ? { payloadTombstoneEligible: true }
          : {}),
        payload,
        payloadFingerprint: fingerprint,
        createdAt,
        dispatchingAt: null,
        acceptedAt: legacyPull ? createdAt : null,
        failedAt: null,
        ambiguousAt: null,
        error: null,
        acknowledgedAt: null,
      }) as LedgerRecord;
      const nextRecords = new Map(state.records);
      nextRecords.set(deliveryId, record);
      this.assertWithinQuota(nextRecords);
      const nextSequence = state.nextSequence + 1;
      throwIfAborted(input.signal, "Delivery send cancelled");
      await this.persist(normalizedOwnerId, nextRecords, nextSequence);
      state.records = nextRecords;
      state.nextSequence = nextSequence;
      return { delivery: cloneDelivery(record), created: true };
    });
  }

  async get(
    ownerId: string,
    options: DeliveryLedgerGetOptions = {},
  ): Promise<DeliveryLedgerGetResult> {
    const normalizedOwnerId = validateOwnerId(ownerId);
    throwIfAborted(options.signal, "Delivery read cancelled");
    const allowPayloadTombstones = options.allowPayloadTombstones === true;
    await this.gc(normalizedOwnerId, allowPayloadTombstones, options.signal);
    const state = this.ownerState(normalizedOwnerId);
    await state.mutationTail;
    await this.ensureLoaded(state, normalizedOwnerId);
    throwIfAborted(options.signal, "Delivery read cancelled");
    const requestId = options.responseRequestId ?? "delivery-request";
    const maxEncodedBytes = options.maxEncodedBytes ?? MAX_DELIVERY_RESPONSE_BYTES;
    if (options.deliveryId !== undefined) {
      return this.getByDeliveryId(
        state,
        options.deliveryId,
        requestId,
        maxEncodedBytes,
        allowPayloadTombstones,
        options.targetAgentId,
      );
    }

    const includeAcknowledged = options.includeAcknowledged === true;
    const limit = this.parseLimit(options.limit);
    const records = this.sortedRecords(state.records);
    const cursor = options.cursor !== undefined ? DeliveryCursorSchema.parse(options.cursor) : null;
    return this.getPage(
      records,
      state.nextSequence,
      cursor,
      includeAcknowledged,
      limit,
      requestId,
      maxEncodedBytes,
      allowPayloadTombstones,
      options.targetAgentId,
    );
  }

  private getByDeliveryId(
    state: OwnerState,
    deliveryId: string,
    requestId: string,
    maxEncodedBytes: number,
    allowPayloadTombstones: boolean,
    targetAgentId?: string,
  ): DeliveryLedgerGetResult {
    const normalizedId = DeliveryIdSchema.parse(deliveryId);
    const delivery = state.records.get(normalizedId);
    const visibleDelivery =
      delivery &&
      (targetAgentId === undefined || delivery.targetAgentId === targetAgentId) &&
      (delivery.payload !== undefined || allowPayloadTombstones)
        ? delivery
        : null;
    const result = {
      delivery: visibleDelivery ? cloneDelivery(visibleDelivery) : null,
      deliveries: visibleDelivery ? [cloneDelivery(visibleDelivery)] : [],
      nextCursor: null,
    } satisfies DeliveryLedgerGetResult;
    this.assertGetResponseWithinBudget(requestId, result, maxEncodedBytes);
    return result;
  }

  private getPage(
    records: LedgerRecord[],
    nextSequence: number,
    cursor: string | null,
    includeAcknowledged: boolean,
    limit: number,
    requestId: string,
    maxEncodedBytes: number,
    allowPayloadTombstones: boolean,
    targetAgentId?: string,
  ): DeliveryLedgerGetResult {
    const cursorResult = this.findCursor(records, cursor, nextSequence);
    if (!cursorResult.valid) {
      throw new DeliveryLedgerError(
        "delivery_cursor_invalid",
        `Delivery cursor ${cursor} is not present in the ledger`,
      );
    }

    const eligible: Array<{ record: LedgerRecord; index: number }> = [];
    for (
      let index = cursorResult.index + 1;
      index < records.length && eligible.length < limit;
      index += 1
    ) {
      const record = records[index];
      if (!isVisibleDelivery(record, includeAcknowledged, allowPayloadTombstones, targetAgentId))
        continue;
      const candidate = eligible.concat({ record, index });
      const hasMoreAfterCandidate = hasVisibleDeliveryAfter(
        records,
        index,
        includeAcknowledged,
        allowPayloadTombstones,
        targetAgentId,
      );
      const candidateResult: DeliveryLedgerGetResult = {
        delivery: null,
        deliveries: candidate.map(({ record: item }) => cloneDelivery(item)),
        nextCursor: hasMoreAfterCandidate ? encodeSequenceCursor(record.sequence) : null,
      };
      if (!this.getResponseFits(requestId, candidateResult, maxEncodedBytes)) {
        if (eligible.length === 0) {
          throw new DeliveryLedgerError(
            "delivery_response_too_large",
            `Delivery ${record.deliveryId} cannot fit within the ${maxEncodedBytes}-byte response budget`,
          );
        }
        break;
      }
      eligible.push({ record, index });
    }

    const last = eligible.at(-1);
    const hasMore =
      last !== undefined &&
      hasVisibleDeliveryAfter(
        records,
        last.index,
        includeAcknowledged,
        allowPayloadTombstones,
        targetAgentId,
      );
    const result: DeliveryLedgerGetResult = {
      delivery: null,
      deliveries: eligible.map(({ record }) => cloneDelivery(record)),
      nextCursor: hasMore ? encodeSequenceCursor(last?.record.sequence ?? 0) : null,
    };
    this.assertGetResponseWithinBudget(requestId, result, maxEncodedBytes);
    return result;
  }

  async acknowledge(
    ownerId: string,
    deliveryId: string,
    options: {
      allowPayloadTombstones?: boolean;
      targetAgentId?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<DeliveryRecord> {
    return this.transition(ownerId, deliveryId, "acknowledged", undefined, options);
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

  async transition(
    ownerId: string,
    deliveryId: string,
    status: DeliveryStatus,
    error?: string,
    options: {
      allowPayloadTombstones?: boolean;
      targetAgentId?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<DeliveryRecord> {
    const normalizedOwnerId = validateOwnerId(ownerId);
    throwIfAborted(options.signal, "Delivery transition cancelled");
    const nextStatus = DeliveryStatusSchema.parse(status);
    const normalizedId = DeliveryIdSchema.parse(deliveryId);
    return this.enqueue(normalizedOwnerId, (state) =>
      this.applyTransition(state, normalizedOwnerId, normalizedId, nextStatus, error, options),
    );
  }

  private async applyTransition(
    state: OwnerState,
    ownerId: string,
    deliveryId: string,
    nextStatus: DeliveryStatus,
    error?: string,
    options: {
      allowPayloadTombstones?: boolean;
      targetAgentId?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<DeliveryRecord> {
    throwIfAborted(options.signal, "Delivery transition cancelled");
    const candidate = state.records.get(deliveryId);
    if (
      options.targetAgentId !== undefined &&
      candidate &&
      candidate.targetAgentId !== options.targetAgentId
    ) {
      throw new DeliveryLedgerError(
        "delivery_target_mismatch",
        `Delivery ${deliveryId} is not targeted to the authorized agent`,
      );
    }
    const existing = this.validateTransition(state, ownerId, deliveryId, nextStatus);
    if (options.targetAgentId !== undefined && existing.targetAgentId !== options.targetAgentId) {
      throw new DeliveryLedgerError(
        "delivery_target_mismatch",
        `Delivery ${deliveryId} is not targeted to the authorized agent`,
      );
    }
    const currentStatus = statusOf(existing);
    if (
      currentStatus === "acknowledged" &&
      nextStatus === "acknowledged" &&
      existing.payload === undefined &&
      options.allowPayloadTombstones !== true
    ) {
      throw new DeliveryLedgerError(
        "delivery_payload_unavailable",
        `Acknowledged delivery ${deliveryId} has no payload for this client`,
      );
    }
    if (currentStatus === nextStatus || currentStatus === "acknowledged") {
      return cloneDelivery(existing);
    }
    const nextRecord = this.buildTransitionRecord(existing, nextStatus, error);
    const nextRecords = new Map(state.records);
    nextRecords.set(deliveryId, nextRecord);
    const compacted = this.compactAcknowledged(
      nextRecords,
      options.allowPayloadTombstones === true,
    );
    this.assertWithinQuota(compacted.records);
    throwIfAborted(options.signal, "Delivery transition cancelled");
    await this.persist(ownerId, compacted.records, state.nextSequence);
    state.records = compacted.records;
    return cloneDelivery(nextRecord);
  }

  private validateTransition(
    state: OwnerState,
    ownerId: string,
    deliveryId: string,
    nextStatus: DeliveryStatus,
  ): LedgerRecord {
    if (state.closing && (nextStatus === "dispatching" || nextStatus === "acknowledged")) {
      throw new DeliveryLedgerError(
        "delivery_owner_closing",
        `Delivery owner ${ownerId} is closing`,
      );
    }
    const existing = state.records.get(deliveryId);
    if (!existing) {
      throw new DeliveryLedgerError("delivery_not_found", `Delivery ${deliveryId} was not found`);
    }
    const currentStatus = statusOf(existing);
    if (currentStatus === "acknowledged") {
      if (nextStatus === "acknowledged") return existing;
      throw new DeliveryLedgerError(
        "delivery_transition_invalid",
        `Cannot transition acknowledged delivery ${deliveryId} to ${nextStatus}`,
      );
    }
    if (nextStatus === "acknowledged" && currentStatus !== "accepted") {
      throw new DeliveryLedgerError(
        "delivery_transition_invalid",
        `Cannot acknowledge delivery ${deliveryId} from ${currentStatus}`,
      );
    }
    if (currentStatus !== nextStatus && !isAllowedTransition(currentStatus, nextStatus)) {
      throw new DeliveryLedgerError(
        "delivery_transition_invalid",
        `Cannot transition delivery ${deliveryId} from ${currentStatus} to ${nextStatus}`,
      );
    }
    return existing;
  }

  private buildTransitionRecord(
    existing: LedgerRecord,
    nextStatus: DeliveryStatus,
    error?: string,
  ): LedgerRecord {
    const timestamp = this.now().toISOString();
    let changes: Partial<DeliveryRecord> = {};
    switch (nextStatus) {
      case "dispatching":
        changes = { dispatchingAt: existing.dispatchingAt ?? timestamp };
        break;
      case "accepted":
        changes = { acceptedAt: existing.acceptedAt ?? timestamp, error: null };
        break;
      case "failed":
        changes = {
          failedAt: existing.failedAt ?? timestamp,
          error: errorText(error ?? "Delivery failed"),
        };
        break;
      case "ambiguous":
        changes = {
          ambiguousAt: existing.ambiguousAt ?? timestamp,
          error: errorText(
            error ?? "Delivery outcome is ambiguous; it will not be retried automatically",
          ),
        };
        break;
      case "acknowledged":
        changes = { acknowledgedAt: existing.acknowledgedAt ?? timestamp };
        break;
      case "recorded":
        break;
    }
    return DeliveryRecordSchema.parse({
      ...existing,
      ...changes,
      status: nextStatus,
    }) as LedgerRecord;
  }

  async gc(ownerId: string, allowPayloadTombstones = false, signal?: AbortSignal): Promise<void> {
    const normalizedOwnerId = validateOwnerId(ownerId);
    throwIfAborted(signal, "Delivery cleanup cancelled");
    await this.enqueue(normalizedOwnerId, async (state) => {
      throwIfAborted(signal, "Delivery cleanup cancelled");
      const compacted = this.compactAcknowledged(state.records, allowPayloadTombstones);
      if (!compacted.changed) return;
      throwIfAborted(signal, "Delivery cleanup cancelled");
      await this.persist(normalizedOwnerId, compacted.records, state.nextSequence);
      state.records = compacted.records;
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
          }) as LedgerRecord,
        );
        changed = true;
      }
      const compacted = this.compactAcknowledged(nextRecords, false);
      if (changed || compacted.changed) {
        await this.persist(normalizedOwnerId, compacted.records, state.nextSequence);
        state.records = compacted.records;
      }
    });
  }

  /** Remove all state for an installation-scoped principal, even if loading failed. */
  async removeOwner(ownerId: string, timeoutMs = this.cleanupTimeoutMs): Promise<void> {
    const normalizedOwnerId = validateOwnerId(ownerId);
    const state = this.ownerState(normalizedOwnerId);
    state.closing = true;
    const next = state.mutationTail
      .catch(() => undefined)
      .then(async () => {
        await state.loadPromise?.catch(() => undefined);
        await this.purgeOwnerFiles(normalizedOwnerId);
        state.records = new Map();
        state.nextSequence = 1;
        state.loaded = true;
        state.retired = true;
        // A rejected load promise is historical state after a purge. Do not
        // retain it for flush/shutdown or allow a later caller to observe it.
        state.loadPromise = null;
        return undefined;
      });
    state.mutationTail = next.then(
      () => undefined,
      () => undefined,
    );
    const completed = await waitForDeadline(next, timeoutMs);
    if (!completed) {
      this.reportCleanupTimeout(normalizedOwnerId, "removeOwner", timeoutMs);
      throw new DeliveryLedgerError(
        "delivery_cleanup_timeout",
        `Timed out removing delivery owner ${normalizedOwnerId}`,
      );
    }
  }

  async purgeOwner(ownerId: string, timeoutMs = this.cleanupTimeoutMs): Promise<void> {
    await this.removeOwner(ownerId, timeoutMs);
  }

  async flush(timeoutMs = this.cleanupTimeoutMs): Promise<void> {
    const states = [...this.owners.entries()];
    const pendingOwners = new Set(states.map(([ownerId]) => ownerId));
    const pending = Promise.all(
      states.map(async ([ownerId, state]) => {
        try {
          await state.mutationTail;
          // Shutdown must not fail because a closed owner retained a historical
          // load rejection (for example, a quarantined symlinked ledger).
          await state.loadPromise?.catch(() => undefined);
        } finally {
          pendingOwners.delete(ownerId);
        }
      }),
    );
    const completed = await waitForDeadline(pending, timeoutMs);
    if (completed) return;
    for (const ownerId of pendingOwners) {
      this.reportCleanupTimeout(ownerId, "flush", timeoutMs);
    }
  }

  private reportCleanupTimeout(
    ownerId: string,
    operation: "flush" | "removeOwner",
    timeoutMs: number,
  ): void {
    this.onDiagnostic?.({
      kind: "cleanup_timeout",
      ownerId,
      filePath: deliveryLedgerFilePath(this.baseDir, ownerId),
      quarantinePath: "",
      operation,
      timeoutMs,
      reason: `Delivery ledger ${operation} exceeded its ${timeoutMs}ms deadline`,
    });
  }

  private ownerState(ownerId: string): OwnerState {
    const normalizedOwnerId = validateOwnerId(ownerId);
    let state = this.owners.get(normalizedOwnerId);
    if (!state) {
      state = {
        records: new Map(),
        nextSequence: 1,
        loaded: false,
        loadPromise: null,
        mutationTail: Promise.resolve(),
        closing: false,
        retired: false,
      };
      this.owners.set(normalizedOwnerId, state);
    }
    return state;
  }

  private assertOwnerOpen(state: OwnerState, ownerId: string): void {
    if (state.closing || state.retired) {
      throw new DeliveryLedgerError(
        "delivery_owner_closing",
        `Delivery owner ${ownerId} is closing`,
      );
    }
  }

  private async ensureLoaded(state: OwnerState, ownerId: string): Promise<void> {
    if (state.loaded) return;
    if (!state.loadPromise) state.loadPromise = this.load(state, ownerId);
    await state.loadPromise;
  }

  private async load(state: OwnerState, ownerId: string): Promise<void> {
    await this.ensureSecureRoot();
    const filePath = deliveryLedgerFilePath(this.baseDir, ownerId);
    const raw = await this.readLedgerFile(filePath, ownerId);
    if (raw === null) {
      state.loaded = true;
      return;
    }

    try {
      const loaded = this.parseLedgerContents(raw, ownerId);
      state.records = loaded.records;
      state.nextSequence = loaded.nextSequence;
      if (loaded.needsPersist) await this.persist(ownerId, state.records, loaded.nextSequence);
      state.loaded = true;
    } catch (error) {
      if (error instanceof DeliveryLedgerError) throw error;
      const quarantinePath = await this.quarantine(filePath, ownerId, error);
      state.records = new Map();
      state.nextSequence = 1;
      state.loaded = true;
      this.onDiagnostic?.({
        kind: "quarantined",
        ownerId,
        filePath,
        quarantinePath,
        reason: errorText(error),
      });
    }
  }

  private parseLedgerContents(raw: string, ownerId: string): LoadedLedgerContents {
    const parsed = this.parseLedgerEnvelope(raw, ownerId);
    const needsSequenceMigration =
      parsed.version === LEGACY_LEDGER_VERSION ||
      parsed.deliveries.some((value) => !hasDurableSequence(value));
    const ordered = needsSequenceMigration
      ? [...parsed.deliveries].sort(compareLegacyDeliveries)
      : parsed.deliveries;
    const records = normalizeLedgerRecords(
      ordered,
      needsSequenceMigration,
      parsed.version === LEGACY_LEDGER_VERSION,
      this.maxPayloadBytes,
    );
    const maximumSequence = Math.max(0, ...[...records.values()].map((record) => record.sequence));
    const nextSequence = resolveNextSequence(parsed, maximumSequence);
    this.assertWithinQuota(records);
    const reconciled = this.reconcileRecords(records);
    const compacted = this.compactAcknowledged(reconciled.records, false);
    return {
      records: compacted.records,
      nextSequence,
      needsPersist:
        parsed.version !== LEDGER_VERSION ||
        needsSequenceMigration ||
        reconciled.changed ||
        compacted.changed,
    };
  }

  private parseLedgerEnvelope(raw: string, ownerId: string): ParsedLedgerEnvelope {
    const parsed = JSON.parse(raw) as Partial<ParsedLedgerEnvelope>;
    if (
      (parsed.version !== LEDGER_VERSION && parsed.version !== LEGACY_LEDGER_VERSION) ||
      parsed.ownerId !== ownerId ||
      !Array.isArray(parsed.deliveries)
    ) {
      throw new Error("Unsupported delivery ledger format");
    }
    return parsed as ParsedLedgerEnvelope;
  }

  private reconcileRecords(records: Map<string, LedgerRecord>): {
    records: Map<string, LedgerRecord>;
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
        }) as LedgerRecord,
      );
      changed = true;
    }
    return { records: nextRecords, changed };
  }

  private compactAcknowledged(
    records: Map<string, LedgerRecord>,
    allowPayloadTombstones: boolean,
  ): {
    records: Map<string, LedgerRecord>;
    changed: boolean;
  } {
    const nowMs = this.now().getTime();
    const nextRecords = new Map(records);
    let changed = false;
    for (const [deliveryId, record] of records) {
      if (statusOf(record) !== "acknowledged" || !record.acknowledgedAt) continue;
      const acknowledgedMs = Date.parse(record.acknowledgedAt);
      if (Number.isFinite(acknowledgedMs) && nowMs - acknowledgedMs >= this.tombstoneRetentionMs) {
        nextRecords.delete(deliveryId);
        changed = true;
      }
    }

    const acknowledgedWithPayload = [...nextRecords.values()]
      .filter(
        (record) =>
          statusOf(record) === "acknowledged" &&
          record.payload !== undefined &&
          record.payloadTombstoneEligible === true &&
          allowPayloadTombstones,
      )
      .sort((left, right) => left.sequence - right.sequence);
    let payloadCount = acknowledgedWithPayload.length;
    let payloadBytes = acknowledgedWithPayload.reduce(
      (total, record) => total + serializedByteLength(record.payload),
      0,
    );
    for (const record of acknowledgedWithPayload) {
      const acknowledgedMs = record.acknowledgedAt ? Date.parse(record.acknowledgedAt) : Number.NaN;
      const aged = Number.isFinite(acknowledgedMs)
        ? nowMs - acknowledgedMs >= this.acknowledgedPayloadMaxAgeMs
        : false;
      if (
        !aged &&
        payloadCount <= this.maxAcknowledgedPayloads &&
        payloadBytes <= this.maxAcknowledgedPayloadBytes
      ) {
        continue;
      }
      const tombstone = DeliveryRecordSchema.parse({
        ...record,
        payload: undefined,
        payloadFingerprint: record.payloadFingerprint,
      }) as LedgerRecord;
      nextRecords.set(record.deliveryId, tombstone);
      payloadCount -= 1;
      payloadBytes -= serializedByteLength(record.payload);
      changed = true;
    }
    return { records: nextRecords, changed };
  }

  private async persist(
    ownerId: string,
    records: Map<string, LedgerRecord>,
    nextSequence: number,
  ): Promise<void> {
    this.assertWithinQuota(records);
    const value: PersistedDeliveryLedger = {
      version: LEDGER_VERSION,
      ownerId,
      nextSequence,
      deliveries: [...records.values()].map(cloneDelivery),
    };
    const serialized = JSON.stringify(value, null, 2);
    if (Buffer.byteLength(serialized, "utf8") > this.maxLedgerBytes) {
      throw new DeliveryLedgerError(
        "delivery_quota_exceeded",
        `Delivery ledger for ${ownerId} exceeds its ${this.maxLedgerBytes}-byte storage limit`,
      );
    }
    try {
      await this.ensureSecureRoot();
      const noFollow = noFollowFlag();
      const filePath = deliveryLedgerFilePath(this.baseDir, ownerId);
      await this.assertWritableLedgerPath(filePath, ownerId);
      const tempPath = path.join(
        this.baseDir,
        `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
      );
      let renamed = false;
      try {
        let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
        try {
          handle = await withTransientRetry(() =>
            fs.open(
              tempPath,
              fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
              0o600,
            ),
          );
          await withTransientRetry(() => handle!.writeFile(serialized, "utf8"));
          await withTransientRetry(() => handle!.chmod(0o600));
          await withTransientRetry(() => handle!.sync());
        } finally {
          await handle?.close().catch(() => undefined);
        }
        await withTransientRetry(() => fs.rename(tempPath, filePath));
        renamed = true;
        await this.assertSecureLedgerFile(filePath, ownerId);
      } finally {
        if (!renamed) {
          await withTransientRetry(() => fs.unlink(tempPath)).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
        }
      }
    } catch (error) {
      if (error instanceof DeliveryLedgerError) throw error;
      throw new DeliveryLedgerError(
        "delivery_ledger_unavailable",
        `Failed to persist the delivery ledger for ${ownerId}`,
        { cause: error },
      );
    }
  }

  private assertWithinQuota(records: Map<string, LedgerRecord>): void {
    const pending = [...records.values()].filter((record) => statusOf(record) !== "acknowledged");
    if (pending.length > this.maxRecordsPerOwner) {
      throw new DeliveryLedgerError(
        "delivery_quota_exceeded",
        `Delivery principal exceeds its ${this.maxRecordsPerOwner}-record quota`,
      );
    }
    const bytes = pending.reduce((total, record) => total + serializedByteLength(record), 0);
    if (bytes > this.maxBytesPerOwner) {
      throw new DeliveryLedgerError(
        "delivery_quota_exceeded",
        `Delivery principal exceeds its ${this.maxBytesPerOwner}-byte pending quota`,
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

  private sortedRecords(records: Map<string, LedgerRecord>): LedgerRecord[] {
    return [...records.values()].sort((left, right) => left.sequence - right.sequence);
  }

  private findCursor(
    records: LedgerRecord[],
    cursor: string | null,
    nextSequence: number,
  ): { valid: boolean; index: number } {
    if (cursor === null) return { valid: true, index: -1 };
    // COMPAT(durableDeliveryCursor): added in v0.7.2; remove after 2027-03-31 once client floor >= v0.7.2 and daemon floor >= v0.7.2.
    const sequence = parseSequenceCursor(cursor);
    if (sequence === null || sequence >= nextSequence) return { valid: false, index: -1 };
    const exactIndex = records.findIndex((record) => record.sequence === sequence);
    if (exactIndex >= 0) return { valid: true, index: exactIndex };
    const nextIndex = records.findIndex((record) => record.sequence > sequence);
    return { valid: true, index: nextIndex < 0 ? records.length - 1 : nextIndex - 1 };
  }

  private getResponseFits(
    requestId: string,
    result: DeliveryLedgerGetResult,
    maxEncodedBytes: number,
  ): boolean {
    const message = {
      type: "session",
      message: { type: "deliveries.get.response", payload: { requestId, ...result } },
    };
    const serialized = JSON.stringify(message);
    return (
      Buffer.byteLength(serialized, "utf8") <=
      Math.min(maxEncodedBytes, MAX_WEBSOCKET_MESSAGE_BYTES)
    );
  }

  private assertGetResponseWithinBudget(
    requestId: string,
    result: DeliveryLedgerGetResult,
    maxEncodedBytes: number,
  ): void {
    if (!this.getResponseFits(requestId, result, maxEncodedBytes)) {
      throw new DeliveryLedgerError(
        "delivery_response_too_large",
        `Delivery response exceeds its ${maxEncodedBytes}-byte budget`,
      );
    }
  }

  private async ensureSecureRoot(): Promise<void> {
    const noFollow = noFollowFlag();
    let info: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      info = await withTransientRetry(() => fs.lstat(this.baseDir));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new DeliveryLedgerError(
          "delivery_ledger_unavailable",
          `Cannot inspect delivery root ${this.baseDir}`,
          { cause: error },
        );
      }
      try {
        await withTransientRetry(() => fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 }));
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new DeliveryLedgerError(
            "delivery_ledger_unavailable",
            `Cannot create delivery root ${this.baseDir}`,
            { cause: mkdirError },
          );
        }
      }
      info = await withTransientRetry(() => fs.lstat(this.baseDir));
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new DeliveryLedgerError(
        "delivery_ledger_unavailable",
        `Delivery root is not a directory: ${this.baseDir}`,
      );
    }
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await withTransientRetry(() =>
        fs.open(this.baseDir, fsConstants.O_RDONLY | O_DIRECTORY | noFollow),
      );
      const opened = await withTransientRetry(() => handle!.stat());
      if (!opened.isDirectory() || !sameFile(info, opened)) {
        throw new Error("Delivery root changed while opening");
      }
      await withTransientRetry(() => handle!.chmod(0o700));
      const secured = await withTransientRetry(() => handle!.stat());
      if (!secured.isDirectory() || (secured.mode & 0o7777) !== 0o700) {
        throw new Error("Delivery root mode could not be enforced");
      }
    } catch (error) {
      if (error instanceof DeliveryLedgerError) throw error;
      throw new DeliveryLedgerError(
        "delivery_ledger_unavailable",
        `Cannot secure delivery root ${this.baseDir}`,
        { cause: error },
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async readLedgerFile(filePath: string, ownerId: string): Promise<string | null> {
    const noFollow = noFollowFlag();
    let info: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      info = await withTransientRetry(() => fs.lstat(filePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new DeliveryLedgerError(
        "delivery_ledger_unavailable",
        `Cannot inspect delivery ledger for ${ownerId}`,
        { cause: error },
      );
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new DeliveryLedgerError(
        "delivery_ledger_unavailable",
        `Delivery ledger is not a regular file for ${ownerId}`,
      );
    }
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await withTransientRetry(() => fs.open(filePath, fsConstants.O_RDONLY | noFollow));
      const opened = await withTransientRetry(() => handle!.stat());
      if (!opened.isFile() || !sameFile(info, opened)) {
        throw new Error("Delivery ledger changed while opening");
      }
      await withTransientRetry(() => handle!.chmod(0o600));
      const secured = await withTransientRetry(() => handle!.stat());
      if (!secured.isFile() || (secured.mode & 0o7777) !== 0o600) {
        throw new Error("Delivery ledger mode could not be enforced");
      }
      if (secured.size > this.maxLedgerBytes) {
        throw new DeliveryLedgerError(
          "delivery_quota_exceeded",
          `Delivery ledger for ${ownerId} exceeds its ${this.maxLedgerBytes}-byte storage limit`,
        );
      }
      const chunks: Buffer[] = [];
      let total = 0;
      while (total <= this.maxLedgerBytes) {
        const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, this.maxLedgerBytes + 1 - total));
        const result = await withTransientRetry(() => handle!.read(chunk, 0, chunk.length, null));
        if (result.bytesRead === 0) break;
        chunks.push(chunk.subarray(0, result.bytesRead));
        total += result.bytesRead;
        if (total > this.maxLedgerBytes) {
          throw new DeliveryLedgerError(
            "delivery_quota_exceeded",
            `Delivery ledger for ${ownerId} exceeds its ${this.maxLedgerBytes}-byte storage limit`,
          );
        }
      }
      return Buffer.concat(chunks, total).toString("utf8");
    } catch (error) {
      if (error instanceof DeliveryLedgerError) throw error;
      throw new DeliveryLedgerError(
        "delivery_ledger_unavailable",
        `Failed to read the delivery ledger for ${ownerId}`,
        { cause: error },
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async assertWritableLedgerPath(filePath: string, ownerId: string): Promise<void> {
    const noFollow = noFollowFlag();
    try {
      const info = await withTransientRetry(() => fs.lstat(filePath));
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new DeliveryLedgerError(
          "delivery_ledger_unavailable",
          `Delivery ledger is not a regular file for ${ownerId}`,
        );
      }
      let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
      try {
        handle = await withTransientRetry(() => fs.open(filePath, fsConstants.O_RDONLY | noFollow));
        const opened = await withTransientRetry(() => handle!.stat());
        if (!opened.isFile() || !sameFile(info, opened)) {
          throw new Error("Delivery ledger changed while checking its write path");
        }
      } finally {
        await handle?.close().catch(() => undefined);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      if (error instanceof DeliveryLedgerError) throw error;
      throw new DeliveryLedgerError(
        "delivery_ledger_unavailable",
        `Cannot inspect delivery ledger for ${ownerId}`,
        { cause: error },
      );
    }
  }

  private async assertSecureLedgerFile(filePath: string, ownerId: string): Promise<void> {
    const noFollow = noFollowFlag();
    const info = await withTransientRetry(() => fs.lstat(filePath));
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new DeliveryLedgerError(
        "delivery_ledger_unavailable",
        `Delivery ledger mode could not be enforced for ${ownerId}`,
      );
    }
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await withTransientRetry(() => fs.open(filePath, fsConstants.O_RDONLY | noFollow));
      const opened = await withTransientRetry(() => handle!.stat());
      if (!opened.isFile() || !sameFile(info, opened)) {
        throw new Error("Delivery ledger changed while checking its mode");
      }
      await withTransientRetry(() => handle!.chmod(0o600));
      const secured = await withTransientRetry(() => handle!.stat());
      if (!secured.isFile() || (secured.mode & 0o7777) !== 0o600) {
        throw new Error("Delivery ledger mode could not be enforced");
      }
    } catch (error) {
      if (error instanceof DeliveryLedgerError) throw error;
      throw new DeliveryLedgerError(
        "delivery_ledger_unavailable",
        `Delivery ledger mode could not be enforced for ${ownerId}`,
        { cause: error },
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async quarantine(filePath: string, ownerId: string, error: unknown): Promise<string> {
    const quarantinePath = `${filePath}.quarantine-${Date.now()}-${randomUUID()}`;
    const noFollow = noFollowFlag();
    try {
      await this.ensureSecureRoot();
      const sourceInfo = await withTransientRetry(() => fs.lstat(filePath));
      if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
        throw new Error("Delivery ledger changed before quarantine");
      }
      let sourceHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
      try {
        sourceHandle = await withTransientRetry(() =>
          fs.open(filePath, fsConstants.O_RDONLY | noFollow),
        );
        const opened = await withTransientRetry(() => sourceHandle!.stat());
        if (!opened.isFile() || !sameFile(sourceInfo, opened)) {
          throw new Error("Delivery ledger changed before quarantine");
        }
      } finally {
        await sourceHandle?.close().catch(() => undefined);
      }
      // Recheck the parent immediately before the path operation. The rename
      // never follows the source link; the parent checks keep the destination
      // inside the private ledger directory across ordinary replacement races.
      await this.ensureSecureRoot();
      await withTransientRetry(() => fs.rename(filePath, quarantinePath));
      await this.ensureSecureRoot();
      let quarantineHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
      try {
        quarantineHandle = await withTransientRetry(() =>
          fs.open(quarantinePath, fsConstants.O_RDONLY | noFollow),
        );
        const quarantined = await withTransientRetry(() => quarantineHandle!.stat());
        if (!quarantined.isFile() || !sameFile(sourceInfo, quarantined)) {
          throw new Error("Quarantine target changed while renaming");
        }
        await withTransientRetry(() => quarantineHandle!.chmod(0o600));
        const secured = await withTransientRetry(() => quarantineHandle!.stat());
        if (!secured.isFile() || (secured.mode & 0o7777) !== 0o600) {
          throw new Error("Quarantine mode could not be enforced");
        }
      } finally {
        await quarantineHandle?.close().catch(() => undefined);
      }
      return quarantinePath;
    } catch (renameError) {
      throw new DeliveryLedgerError(
        "delivery_ledger_unavailable",
        `Failed to quarantine malformed delivery ledger for ${ownerId}: ${errorText(error)}`,
        { cause: renameError },
      );
    }
  }

  private async purgeOwnerFiles(ownerId: string): Promise<void> {
    await this.ensureSecureRoot();
    const filePath = deliveryLedgerFilePath(this.baseDir, ownerId);
    const prefix = `${path.basename(filePath)}.quarantine-`;
    const entries = await withTransientRetry(() => fs.readdir(this.baseDir));
    const targets = entries
      .filter((entry) => entry === path.basename(filePath) || entry.startsWith(prefix))
      .map((entry) => path.join(this.baseDir, entry));
    await Promise.all(
      targets.map(async (target) => {
        await withTransientRetry(() => fs.unlink(target)).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }),
    );
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

async function waitForDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new Error("timeoutMs must be a non-negative safe integer");
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function encodeSequenceCursor(sequence: number): string {
  return `seq:${sequence}`;
}

function parseSequenceCursor(cursor: string): number | null {
  let sequenceText: string | null = null;
  const parsed = DeliverySequenceCursorSchema.safeParse(cursor);
  if (parsed.success) {
    sequenceText = parsed.data.slice(4);
  } else if (/^[1-9]\d*$/.test(cursor)) {
    sequenceText = cursor;
  }
  if (sequenceText === null) return null;
  const sequence = Number(sequenceText);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

function isAllowedTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  if (from === "recorded") return to === "dispatching";
  if (from === "dispatching") return to === "accepted" || to === "failed" || to === "ambiguous";
  if (from === "accepted" || from === "failed" || from === "ambiguous")
    return to === "acknowledged";
  return false;
}
