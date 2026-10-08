import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";

export interface ReceiptAdmission {
  bootId: string;
  sessionIncarnation: string;
  permissionGeneration: number;
}

const ReceiptSchema = z.object({
  fingerprint: z.string(),
  // Optional on read so receipts written before this field existed still parse.
  admission: z
    .object({
      bootId: z.string(),
      sessionIncarnation: z.string(),
      permissionGeneration: z.number().int().nonnegative(),
    })
    .optional(),
  state: z.enum(["pending", "completed"]),
  delivery: z.string().nullable(),
});

export type ReceiptOutcome =
  | { kind: "none" }
  | { kind: "duplicate"; delivery: string | null }
  | { kind: "outcome_unknown" }
  | { kind: "idempotency_conflict" };

/**
 * Durable at-most-once record for keeper sends. A receipt exists only once a send was admitted:
 * "pending" survives a crash or timeout and blocks resending, "completed" answers retries.
 */
export class KeeperSendReceipts {
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(private readonly directory: string) {}

  /** Serializes everything for one key, so a retry waits for the attempt it repeats. */
  serialize<T>(agentId: string, key: string, operation: () => Promise<T>): Promise<T> {
    const id = digest(agentId, key);
    const run = (this.tails.get(id) ?? Promise.resolve()).catch(() => undefined).then(operation);
    const tail = run.catch(() => undefined);
    this.tails.set(id, tail);
    void tail.finally(() => {
      if (this.tails.get(id) === tail) this.tails.delete(id);
    });
    return run;
  }

  async lookup(agentId: string, key: string, fingerprint: string): Promise<ReceiptOutcome> {
    let receipt: z.infer<typeof ReceiptSchema> | null;
    try {
      receipt = await this.read(agentId, key);
    } catch {
      return { kind: "outcome_unknown" };
    }
    if (!receipt) return { kind: "none" };
    if (receipt.fingerprint !== fingerprint) return { kind: "idempotency_conflict" };
    if (receipt.state === "completed") return { kind: "duplicate", delivery: receipt.delivery };
    return { kind: "outcome_unknown" };
  }

  async reserve(
    agentId: string,
    key: string,
    fingerprint: string,
    admission: ReceiptAdmission,
  ): Promise<ReceiptOutcome> {
    const existing = await this.lookup(agentId, key, fingerprint);
    if (existing.kind !== "none") return existing;
    await writeJsonFileAtomic(this.file(agentId, key), {
      fingerprint,
      admission,
      state: "pending",
      delivery: null,
    });
    return existing;
  }

  async release(agentId: string, key: string): Promise<void> {
    await rm(this.file(agentId, key), { force: true });
  }

  async complete(
    agentId: string,
    key: string,
    fingerprint: string,
    delivery: string,
    admission: ReceiptAdmission,
  ): Promise<void> {
    await writeJsonFileAtomic(this.file(agentId, key), {
      fingerprint,
      admission,
      state: "completed",
      delivery,
    });
  }

  private file(agentId: string, key: string): string {
    return path.join(this.directory, `${digest(agentId, key)}.json`);
  }

  private async read(agentId: string, key: string): Promise<z.infer<typeof ReceiptSchema> | null> {
    try {
      return ReceiptSchema.parse(JSON.parse(await readFile(this.file(agentId, key), "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }
}

/** Stable id of a send attempt: hex sha256 over length-prefixed ("sendkey", agentId, idempotencyKey). */
export function sendKey(agentId: string, key: string): string {
  return digest("sendkey", agentId, key);
}

export function sendFingerprint(text: string, onActiveTurn: string): string {
  return digest("send", text, onActiveTurn);
}

function digest(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${part.length}:${part}`);
  return hash.digest("hex");
}
