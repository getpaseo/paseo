import { createHash } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";

const ReceiptSchema = z.object({
  fingerprint: z.string(),
  state: z.enum(["pending", "completed"]),
  agentId: z.string(),
});
const AcceptedSchema = z.object({
  agentId: z.string(),
  messageId: z.string(),
  fingerprint: z.string(),
  request: z.unknown(),
  delivery: z.unknown(),
});

/** A message answered before delivery whose provider dispatch has not happened yet. */
export interface AcceptedMessage {
  agentId: string;
  messageId: string;
  request: unknown;
  /** What the caller saved to deliver the message again after a restart. */
  delivery: unknown;
}

interface SendMessageInput {
  agentId: string;
  messageId: string;
  request: unknown;
  /**
   * Delivers the message. It awaits `beforeDispatch` immediately before the provider can receive
   * the message; a failure before that call proves nothing was submitted and leaves no receipt.
   */
  send: (beforeDispatch: () => Promise<void>) => Promise<void>;
  /**
   * Answer before delivering: the message is saved first, then `onAccepted` runs, then `send`.
   * A daemon that stops before dispatch finds the saved message in {@link listAccepted}.
   */
  accept?: { delivery: unknown; onAccepted: () => void };
  /**
   * A saved message is dropped when delivery fails before dispatch, since the caller reports
   * the failure. It is kept, for the next start to deliver, when this returns true, as it does
   * while the daemon is stopping.
   */
  keepAcceptedAfter?: (error: unknown) => boolean;
}

/** Owns message delivery receipts; creation is owned by CreationService. */
export class MessageReceipts {
  private readonly pending = new Map<string, Promise<void>>();
  /** Deliveries of messages answered before delivery, by agent, until they settle. */
  private readonly acceptedDeliveries = new Map<string, Set<Promise<void>>>();
  private readonly acceptedDirectory: string;
  constructor(private readonly directory: string) {
    this.acceptedDirectory = path.join(directory, "accepted");
  }

  send(input: SendMessageInput): Promise<void> {
    // Preserve the existing on-disk identity and shape across daemon upgrades.
    const key = digest(["send", input.agentId, input.messageId]);
    const previous = this.pending.get(key);
    const result = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
      this.sendOnce(key, input),
    );
    this.pending.set(key, result);
    void result
      .finally(() => {
        if (this.pending.get(key) === result) this.pending.delete(key);
      })
      .catch(() => undefined);
    return result;
  }

  /**
   * Resolves once every message answered before delivery for the agent has been delivered or
   * has failed, so a wait for the agent's turn does not finish before the turn has started.
   */
  async waitForAccepted(agentId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    for (;;) {
      const deliveries = this.acceptedDeliveries.get(agentId);
      if (!deliveries?.size) return;
      let onAbort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new DOMException("Wait aborted", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        await Promise.race([Promise.allSettled(deliveries), aborted]);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }

  /** Messages accepted by an earlier run of the daemon that never reached their provider. */
  async listAccepted(): Promise<AcceptedMessage[]> {
    let names: string[];
    try {
      names = await readdir(this.acceptedDirectory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const accepted: AcceptedMessage[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const saved = await readAccepted(path.join(this.acceptedDirectory, name));
      if (saved) {
        const { agentId, messageId, request, delivery } = saved;
        accepted.push({ agentId, messageId, request, delivery });
      }
    }
    return accepted;
  }

  private async sendOnce(key: string, input: SendMessageInput): Promise<void> {
    const file = path.join(this.directory, `${key}.json`);
    const acceptedFile = path.join(this.acceptedDirectory, `${key}.json`);
    const fingerprint = digest(input.request);
    const existing = await readReceipt(file);
    if (existing) {
      // Dispatch wrote the receipt, so a saved copy of the message is stale.
      await rm(acceptedFile, { force: true });
      if (existing.fingerprint !== fingerprint) throw new Error("agent_request_key_conflict");
      if (existing.state === "completed") return;
      // A provider may have accepted the message before its receipt was committed.
      throw new Error("agent_request_outcome_unknown");
    }
    // A saved message never reached a provider: dispatch writes the receipt before removing it.
    const saved = await readAccepted(acceptedFile);
    if (saved && saved.fingerprint !== fingerprint) throw new Error("agent_request_key_conflict");
    if (!input.accept && !saved) {
      await this.deliver(input, file, acceptedFile, fingerprint);
      return;
    }
    const settle = this.trackAcceptedDelivery(input.agentId);
    try {
      if (input.accept) {
        if (!saved) {
          await writeJsonFileAtomic(acceptedFile, {
            agentId: input.agentId,
            messageId: input.messageId,
            fingerprint,
            request: input.request,
            delivery: input.accept.delivery,
          });
        }
        input.accept.onAccepted();
      }
      await this.deliver(input, file, acceptedFile, fingerprint);
    } finally {
      settle();
    }
  }

  /** Returns the function that marks the delivery settled. */
  private trackAcceptedDelivery(agentId: string): () => void {
    let settle!: () => void;
    const delivery = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const deliveries = this.acceptedDeliveries.get(agentId) ?? new Set<Promise<void>>();
    deliveries.add(delivery);
    this.acceptedDeliveries.set(agentId, deliveries);
    return () => {
      settle();
      deliveries.delete(delivery);
      if (!deliveries.size) this.acceptedDeliveries.delete(agentId);
    };
  }

  private async deliver(
    input: SendMessageInput,
    file: string,
    acceptedFile: string,
    fingerprint: string,
  ): Promise<void> {
    const receipt = { fingerprint, agentId: input.agentId };
    let pending: Promise<void> | null = null;
    try {
      await input.send(() => {
        pending ??= writeJsonFileAtomic(file, { ...receipt, state: "pending" }).then(() =>
          rm(acceptedFile, { force: true }),
        );
        return pending;
      });
    } catch (error) {
      // Nothing reached the provider and the caller reports the failure, so a later start
      // must not deliver the message behind the user's back.
      if (!pending && !input.keepAcceptedAfter?.(error)) await rm(acceptedFile, { force: true });
      throw error;
    }
    await writeJsonFileAtomic(file, { ...receipt, state: "completed" });
  }
}

/** The receipt says the message was already handled, or that it may have been. */
export function isReceiptOutcomeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "agent_request_outcome_unknown" ||
      error.message === "agent_request_key_conflict")
  );
}

async function readReceipt(file: string): Promise<z.infer<typeof ReceiptSchema> | null> {
  const value = await readJson(file);
  return value === null ? null : ReceiptSchema.parse(value);
}

async function readAccepted(file: string): Promise<z.infer<typeof AcceptedSchema> | null> {
  const value = await readJson(file);
  return value === null ? null : AcceptedSchema.parse(value);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, candidate: unknown) => {
        if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
          return Object.fromEntries(
            Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b)),
          );
        }
        return candidate;
      }),
    )
    .digest("hex");
}
