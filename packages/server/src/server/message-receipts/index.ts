import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { AgentTurnNotAcceptedError } from "../agent/agent-sdk-types.js";

/** A final admission decision, not a transient provider failure. */
export class AgentRequestRejectedError extends Error {
  constructor() {
    super("agent_request_rejected");
  }
}

const ReceiptSchema = z.object({
  fingerprint: z.string(),
  state: z.enum(["pending", "completed"]),
  agentId: z.string(),
  rejected: z.literal(true).optional(),
});
interface SendMessageInput {
  agentId: string;
  messageId: string;
  request: unknown;
  send: () => Promise<void>;
  prepare?: () => Promise<void>;
}

/** Owns message delivery receipts; creation is owned by CreationService. */
export class MessageReceipts {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(private readonly directory: string) {}

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

  private async sendOnce(key: string, input: SendMessageInput): Promise<void> {
    const file = path.join(this.directory, `${key}.json`);
    const fingerprint = digest(input.request);
    const existing = await readReceipt(file);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("agent_request_key_conflict");
      if (existing.state === "completed") {
        if (existing.rejected) throw new AgentRequestRejectedError();
        return;
      }
      // A provider may have accepted the message before its receipt was committed.
      throw new Error("agent_request_outcome_unknown");
    }
    try {
      await input.prepare?.();
    } catch (error) {
      throw new AgentTurnNotAcceptedError(
        `agent_request_not_accepted: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const receipt = { fingerprint, agentId: input.agentId };
    await writeJsonFileAtomic(file, { ...receipt, state: "pending" });
    try {
      await input.send();
    } catch (error) {
      if (error instanceof AgentRequestRejectedError) {
        await writeJsonFileAtomic(file, { ...receipt, state: "completed", rejected: true });
        throw error;
      }
      if (error instanceof AgentTurnNotAcceptedError) {
        await rm(file, { force: true });
        throw new AgentTurnNotAcceptedError(`agent_request_not_accepted: ${error.message}`, {
          cause: error,
        });
      }
      throw new Error(
        `agent_request_outcome_unknown: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
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
