import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../../atomic-file.js";

const ReceiptSchema = z.object({
  fingerprint: z.string(),
  agentId: z.string(),
  state: z.enum(["pending", "completed"]),
});
type Receipt = z.infer<typeof ReceiptSchema>;

/** One daemon-owned request journal, shared by all of its socket sessions. */
export class AgentRequests {
  private readonly pending = new Map<string, Promise<string>>();

  constructor(private readonly directory: string) {}

  create(input: {
    key: string;
    request: unknown;
    findAgent: (agentId: string) => Promise<boolean>;
    create: (agentId: string) => Promise<void>;
  }): Promise<string> {
    return this.execute(["create", input.key], input.request, {
      agentId: randomUUID(),
      recover: input.findAgent,
      run: input.create,
      retrySafe: async (agentId) => !(await input.findAgent(agentId)),
    });
  }

  async send(input: {
    agentId: string;
    messageId: string;
    request: unknown;
    send: () => Promise<void>;
    prepare?: () => Promise<void>;
  }): Promise<void> {
    await this.execute(["send", input.agentId, input.messageId], input.request, {
      agentId: input.agentId,
      // A provider call can take effect before the daemon records its outcome.
      // Never repeat that call merely because a process died in this window.
      recover: async () => false,
      run: input.send,
      prepare: input.prepare,
    });
  }

  private execute(
    identity: string[],
    request: unknown,
    operation: {
      agentId: string;
      recover: (agentId: string) => Promise<boolean>;
      run: (agentId: string) => Promise<void>;
      prepare?: (() => Promise<void>) | undefined;
      retrySafe?: (agentId: string) => Promise<boolean>;
    },
  ): Promise<string> {
    const key = digest(identity);
    const fingerprint = digest(request);
    const previous = this.pending.get(key);
    // Serialize even conflicting requests: each caller validates its own fingerprint.
    const result = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
      this.executeOnce(key, fingerprint, operation),
    );
    this.pending.set(key, result);
    void result
      .finally(() => {
        if (this.pending.get(key) === result) this.pending.delete(key);
      })
      .catch(() => undefined);
    return result;
  }

  private async executeOnce(
    key: string,
    fingerprint: string,
    operation: {
      agentId: string;
      recover: (agentId: string) => Promise<boolean>;
      run: (agentId: string) => Promise<void>;
      prepare?: (() => Promise<void>) | undefined;
      retrySafe?: (agentId: string) => Promise<boolean>;
    },
  ): Promise<string> {
    const file = path.join(this.directory, `${key}.json`);
    const existing = await readReceipt(file);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("agent_request_key_conflict");
      if (existing.state === "completed") return existing.agentId;
      if (!(await operation.recover(existing.agentId))) {
        throw new Error("agent_request_outcome_unknown");
      }
      await writeJsonFileAtomic(file, { ...existing, state: "completed" });
      return existing.agentId;
    }
    await operation.prepare?.();
    const receipt: Receipt = { fingerprint, agentId: operation.agentId, state: "pending" };
    await writeJsonFileAtomic(file, receipt);
    try {
      await operation.run(receipt.agentId);
    } catch (error) {
      // Keyed creation has no initial prompt. Once its normal cleanup finished,
      // absence of an agent confirms that retrying cannot duplicate one.
      if (await operation.retrySafe?.(receipt.agentId)) await rm(file, { force: true });
      throw error;
    }
    await writeJsonFileAtomic(file, { ...receipt, state: "completed" });
    return receipt.agentId;
  }
}

async function readReceipt(file: string): Promise<Receipt | null> {
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
