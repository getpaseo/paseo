import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import equal from "fast-deep-equal";
import {
  DeliveryIdSchema,
  DeliveryRecordSchema,
  type DeliveryPayload,
  type DeliveryRecord,
} from "@getpaseo/protocol/deliveries";
import { writeJsonFileAtomic } from "../atomic-file.js";

const LEDGER_VERSION = 1;
const DEFAULT_PAGE_SIZE = 100;

export interface DeliveryLedgerGetOptions {
  deliveryId?: string;
  includeAcknowledged?: boolean;
  cursor?: string;
  limit?: number;
}

export interface DeliveryLedgerSendInput {
  deliveryId?: string;
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

export class DeliveryLedgerError extends Error {
  constructor(
    readonly code: "delivery_id_conflict" | "delivery_not_found" | "delivery_ledger_unavailable",
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

export function deliveryLedgerFilePath(baseDir: string, ownerId: string): string {
  return path.join(baseDir, ownerFileName(ownerId));
}

function cloneDelivery(record: DeliveryRecord): DeliveryRecord {
  return {
    ...record,
    payload: JSON.parse(JSON.stringify(record.payload)) as DeliveryPayload,
  };
}

/**
 * Durable, principal-scoped delivery records.
 *
 * A mutation is acknowledged by this class only after the owner file has been
 * atomically replaced. The per-owner queue also makes retries and concurrent
 * send/acknowledge calls deterministic within a daemon process.
 */
export class DeliveryLedger {
  private readonly owners = new Map<string, OwnerState>();
  private readonly now: () => Date;

  constructor(
    private readonly baseDir: string,
    options?: {
      now?: () => Date;
    },
  ) {
    this.now = options?.now ?? (() => new Date());
  }

  async initialize(ownerId = "owner"): Promise<void> {
    await this.ensureLoaded(this.ownerState(ownerId), ownerId);
  }

  async send(ownerId: string, input: DeliveryLedgerSendInput): Promise<DeliveryLedgerSendResult> {
    return this.enqueue(ownerId, async (state) => {
      const deliveryId = DeliveryIdSchema.parse(input.deliveryId ?? randomUUID());
      const existing = state.records.get(deliveryId);
      if (existing) {
        if (!equal(existing.payload, input.payload)) {
          throw new DeliveryLedgerError(
            "delivery_id_conflict",
            `Delivery ${deliveryId} already exists with a different payload`,
          );
        }
        return { delivery: cloneDelivery(existing), created: false };
      }

      const record = DeliveryRecordSchema.parse({
        deliveryId,
        payload: input.payload,
        createdAt: this.now().toISOString(),
        acknowledgedAt: null,
      });
      const nextRecords = new Map(state.records);
      nextRecords.set(deliveryId, record);
      await this.persist(ownerId, nextRecords);
      state.records = nextRecords;
      return { delivery: cloneDelivery(record), created: true };
    });
  }

  async get(
    ownerId: string,
    options: DeliveryLedgerGetOptions = {},
  ): Promise<DeliveryLedgerGetResult> {
    const state = this.ownerState(ownerId);
    await state.mutationTail;
    await this.ensureLoaded(state, ownerId);

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
    const records = [...state.records.values()].filter(
      (record) => includeAcknowledged || record.acknowledgedAt === null,
    );
    const cursor = options.cursor ? DeliveryIdSchema.parse(options.cursor) : null;
    const cursorIndex = cursor ? records.findIndex((record) => record.deliveryId === cursor) : -1;
    const start = cursorIndex >= 0 ? cursorIndex + 1 : 0;
    const limit = options.limit ?? DEFAULT_PAGE_SIZE;
    const page = records.slice(start, start + limit);
    const nextCursor =
      start + page.length < records.length ? (page.at(-1)?.deliveryId ?? null) : null;
    return {
      delivery: null,
      deliveries: page.map(cloneDelivery),
      nextCursor,
    };
  }

  async acknowledge(ownerId: string, deliveryId: string): Promise<DeliveryRecord> {
    return this.enqueue(ownerId, async (state) => {
      const normalizedId = DeliveryIdSchema.parse(deliveryId);
      const existing = state.records.get(normalizedId);
      if (!existing) {
        throw new DeliveryLedgerError(
          "delivery_not_found",
          `Delivery ${normalizedId} was not found`,
        );
      }
      if (existing.acknowledgedAt !== null) {
        return cloneDelivery(existing);
      }

      const acknowledged = DeliveryRecordSchema.parse({
        ...existing,
        acknowledgedAt: this.now().toISOString(),
      });
      const nextRecords = new Map(state.records);
      nextRecords.set(normalizedId, acknowledged);
      await this.persist(ownerId, nextRecords);
      state.records = nextRecords;
      return cloneDelivery(acknowledged);
    });
  }

  async flush(): Promise<void> {
    await Promise.all([...this.owners.values()].map((state) => state.mutationTail));
  }

  private ownerState(ownerId: string): OwnerState {
    if (ownerId.trim().length === 0) {
      throw new Error("Delivery ledger requires an owner");
    }
    let state = this.owners.get(ownerId);
    if (!state) {
      state = {
        records: new Map(),
        loaded: false,
        loadPromise: null,
        mutationTail: Promise.resolve(),
      };
      this.owners.set(ownerId, state);
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
        const record = DeliveryRecordSchema.parse(value);
        if (records.has(record.deliveryId)) {
          throw new Error(`Duplicate delivery ${record.deliveryId}`);
        }
        records.set(record.deliveryId, record);
      }
      state.records = records;
      state.loaded = true;
    } catch (error) {
      throw new DeliveryLedgerError(
        "delivery_ledger_unavailable",
        `Failed to parse the delivery ledger for ${ownerId}`,
        { cause: error },
      );
    }
  }

  private async persist(ownerId: string, records: Map<string, DeliveryRecord>): Promise<void> {
    const value: PersistedDeliveryLedger = {
      version: LEDGER_VERSION,
      ownerId,
      deliveries: [...records.values()].map(cloneDelivery),
    };
    try {
      await writeJsonFileAtomic(deliveryLedgerFilePath(this.baseDir, ownerId), value);
    } catch (error) {
      throw new DeliveryLedgerError(
        "delivery_ledger_unavailable",
        `Failed to persist the delivery ledger for ${ownerId}`,
        { cause: error },
      );
    }
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
