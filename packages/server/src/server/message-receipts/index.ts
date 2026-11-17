import { MessageDeliveryError, deliveryFailureOutcome } from "./outcome.js";
import { messageFingerprint } from "./fingerprint.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";

const ReceiptSchema = z.object({
  fingerprint: z.string(),
  state: z.enum(["pending", "completed"]),
  agentId: z.string(),
  failure: z.object({ outcome: z.enum(["not_submitted", "rejected"]) }).optional(),
});
interface SendMessageInput {
  agentId: string;
  messageId: string;
  request: unknown;
  isAccepted?: () => Promise<boolean>;
  onCompleted?: () => Promise<void>;
  /**
   * Delivers the message. It awaits `beforeDispatch` immediately before the provider can receive
   * the message; a failure before that call proves nothing was submitted and records negative evidence.
   */
  send: (beforeDispatch: () => Promise<void>) => Promise<void>;
}

export interface MessageDeliveryStatus {
  status: "accepted" | "rejected" | "in_flight" | "unknown";
  failure?: { outcome: "not_submitted" | "rejected"; message: string };
}
type MessageDeliveryStatusInput = Omit<SendMessageInput, "send" | "onCompleted">;

/** Owns message delivery receipts; creation is owned by CreationService. */
export class MessageReceipts {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(private readonly directory: string) {}

  send(input: SendMessageInput): Promise<void> {
    // Preserve the existing on-disk identity and shape across daemon upgrades.
    const key = messageFingerprint(["send", input.agentId, input.messageId]);
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

  async getStatus(input: MessageDeliveryStatusInput): Promise<MessageDeliveryStatus> {
    const key = messageFingerprint(["send", input.agentId, input.messageId]);
    const existing = await readReceipt(path.join(this.directory, `${key}.json`));
    if (existing && existing.fingerprint !== messageFingerprint(input.request))
      throw new MessageDeliveryError({
        outcome: "not_submitted",
        message: "agent_request_key_conflict",
      });
    if (existing?.state === "completed" || (await input.isAccepted?.()))
      return { status: "accepted" };
    if (this.pending.has(key)) return { status: "in_flight" };
    if (existing?.failure) return this.rejectedStatus(existing.failure);
    // A completed receipt may replace the acceptance record during this read.
    const latest = await readReceipt(path.join(this.directory, `${key}.json`));
    if (latest && latest.fingerprint !== messageFingerprint(input.request))
      throw new MessageDeliveryError({
        outcome: "not_submitted",
        message: "agent_request_key_conflict",
      });
    if (latest?.state === "completed") return { status: "accepted" };
    if (latest?.failure) return this.rejectedStatus(latest.failure);
    // Absence is not proof of non-delivery: the message may predate durable receipts.
    return { status: "unknown" };
  }

  private rejectedStatus(failure: {
    outcome: "not_submitted" | "rejected";
  }): MessageDeliveryStatus {
    return {
      status: "rejected",
      failure: {
        outcome: failure.outcome,
        message:
          failure.outcome === "not_submitted"
            ? "The message was not submitted. You can retry it."
            : "The provider rejected this message. You can retry it.",
      },
    };
  }

  private async sendOnce(key: string, input: SendMessageInput): Promise<void> {
    const file = path.join(this.directory, `${key}.json`);
    const fingerprint = messageFingerprint(input.request);
    const existing = await readReceipt(file);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new MessageDeliveryError({
          outcome: "not_submitted",
          message: "agent_request_key_conflict",
        });
      if (existing.state === "completed") {
        await input.onCompleted?.().catch(() => undefined);
        return;
      }
      // A provider may have accepted the message before its receipt was committed.
      if (await input.isAccepted?.()) {
        await writeJsonFileAtomic(file, { ...existing, state: "completed" });
        await input.onCompleted?.().catch(() => undefined);
        return;
      }
      if (!existing.failure)
        throw new MessageDeliveryError({
          outcome: "unknown",
          message: "agent_request_outcome_unknown",
        });
    }
    const receipt = { fingerprint, agentId: input.agentId };
    let pending: Promise<void> | null = null;
    try {
      await input.send(() => {
        pending ??= writeJsonFileAtomic(file, { ...receipt, state: "pending" });
        return pending.catch((cause) => {
          throw new MessageDeliveryError({ outcome: "not_submitted", cause });
        });
      });
    } catch (error) {
      if (!(await input.isAccepted?.())) {
        const outcome = deliveryFailureOutcome(error, pending ? "unknown" : "not_submitted");
        if (outcome !== "unknown") {
          await writeJsonFileAtomic(file, {
            ...receipt,
            state: "pending",
            failure: { outcome },
          });
        }
        throw new MessageDeliveryError({ outcome, cause: error });
      }
    }
    await writeJsonFileAtomic(file, { ...receipt, state: "completed" });
    await input.onCompleted?.().catch(() => undefined);
  }
}

async function readReceipt(file: string): Promise<z.infer<typeof ReceiptSchema> | null> {
  try {
    return ReceiptSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
