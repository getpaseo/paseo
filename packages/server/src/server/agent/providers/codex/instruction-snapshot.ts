import { createHash } from "node:crypto";
import { CodexAppServerRpcError } from "./app-server-transport.js";

/** The receipt records only which snapshot was delivered to a particular native thread. */
interface InstructionReceipt {
  threadId: string;
  digest: string;
}

function readReceipt(value: unknown): InstructionReceipt | null {
  if (!value || typeof value !== "object") return null;
  const receipt = value as Record<string, unknown>;
  if (typeof receipt.threadId !== "string" || typeof receipt.digest !== "string") return null;
  if (!/^[a-f0-9]{64}$/.test(receipt.digest)) return null;
  return { threadId: receipt.threadId, digest: receipt.digest };
}

export class CodexInstructionSnapshot {
  private receipt: InstructionReceipt | null;
  private readonly digest: string;

  constructor(
    private readonly instructions: string | undefined,
    receipt: unknown,
  ) {
    this.receipt = readReceipt(receipt);
    this.digest = createHash("sha256")
      .update(JSON.stringify({ version: 1, instructions: instructions ?? "" }))
      .digest("hex");
  }

  /** A new thread receives its first snapshot through thread/start. */
  recordNewThread(threadId: string): void {
    this.receipt = { threadId, digest: this.digest };
  }

  describe(threadId: string): InstructionReceipt | undefined {
    return this.receipt?.threadId === threadId ? { ...this.receipt } : undefined;
  }

  async apply(
    threadId: string,
    request: (method: string, params: unknown) => Promise<unknown>,
    supported: boolean,
  ): Promise<void> {
    if (this.receipt?.threadId === threadId && this.receipt.digest === this.digest) return;
    if (!supported)
      throw new Error("Update Codex to 0.121.0 or newer to apply agent instruction updates.");
    const snapshot = JSON.stringify({ version: 1, instructions: this.instructions ?? "" });
    const text =
      "This is the complete current set of Paseo-supplied instructions. It supersedes all earlier Paseo-supplied instructions in the conversation, including earlier snapshots. An empty instruction string means there are no current Paseo-supplied instructions. Provider and collaboration instructions remain in effect.\n\n<paseo_instruction_snapshot>" +
      snapshot +
      "</paseo_instruction_snapshot>";
    try {
      await request("thread/inject_items", {
        threadId,
        items: [{ type: "message", role: "developer", content: [{ type: "input_text", text }] }],
      });
    } catch (error) {
      if (error instanceof CodexAppServerRpcError && error.code === -32601) {
        throw new Error("Update Codex to 0.121.0 or newer to apply agent instruction updates.", {
          cause: error,
        });
      }
      throw error;
    }
    this.receipt = { threadId, digest: this.digest };
  }
}
