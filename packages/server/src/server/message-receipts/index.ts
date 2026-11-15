import { messageFingerprint } from "./fingerprint.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";

const ReceiptSchema = z.object({
  fingerprint: z.string(),
  state: z.enum(["pending", "completed"]),
  agentId: z.string(),
});
interface SendMessageInput {
  agentId: string;
  messageId: string;
  request: unknown;
  isAccepted?: () => Promise<boolean>;
  /**
   * Delivers the message. It awaits `beforeDispatch` immediately before the provider can receive
   * the message; a failure before that call proves nothing was submitted and leaves no receipt.
   */
  send: (beforeDispatch: () => Promise<void>) => Promise<void>;
}

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

  private async sendOnce(key: string, input: SendMessageInput): Promise<void> {
    const file = path.join(this.directory, `${key}.json`);
    const fingerprint = messageFingerprint(input.request);
    const existing = await readReceipt(file);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("agent_request_key_conflict");
      if (existing.state === "completed") return;
      // A provider may have accepted the message before its receipt was committed.
      if (!(await input.isAccepted?.())) throw new Error("agent_request_outcome_unknown");
      await writeJsonFileAtomic(file, { ...existing, state: "completed" });
      return;
    }
    const receipt = { fingerprint, agentId: input.agentId };
    let pending: Promise<void> | null = null;
    try {
      await input.send(() => {
        pending ??= writeJsonFileAtomic(file, { ...receipt, state: "pending" });
        return pending;
      });
    } catch (error) {
      if (!pending || !(await input.isAccepted?.())) throw error;
    }
    await writeJsonFileAtomic(file, { ...receipt, state: "completed" });
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
