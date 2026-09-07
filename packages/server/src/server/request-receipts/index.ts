import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";

const ReceiptStateSchema = z.object({
  fingerprint: z.string(),
  state: z.enum(["pending", "completed"]),
});
// Preserve existing agent receipt files while giving workspaces their own identity.
const ReceiptSchema = z.union([
  ReceiptStateSchema.extend({ agentId: z.string() }),
  ReceiptStateSchema.extend({ workspaceId: z.string() }),
]);
type Receipt = z.infer<typeof ReceiptStateSchema> & {
  resource: { kind: "agent" | "workspace"; id: string };
};

interface CreateAgentInput {
  key: string;
  request: unknown;
  findAgent: (agentId: string) => Promise<boolean>;
  create: (agentId: string) => Promise<void>;
}

interface CreateWorkspaceInput {
  key: string;
  request: unknown;
  workspaceId: string;
  findWorkspace: (workspaceId: string) => Promise<boolean>;
  create: (workspaceId: string) => Promise<void>;
}

interface SendMessageInput {
  agentId: string;
  messageId: string;
  request: unknown;
  send: () => Promise<void>;
  prepare?: () => Promise<void>;
}

/** One daemon-owned request journal, shared by all of its socket sessions. */
export class RequestReceipts {
  private readonly pending = new Map<string, Promise<string>>();

  constructor(private readonly directory: string) {}

  createAgent(input: CreateAgentInput): Promise<string> {
    return this.execute(["create", input.key], input.request, {
      resource: { kind: "agent", id: randomUUID() },
      recover: input.findAgent,
      run: input.create,
      retrySafe: async (agentId) => !(await input.findAgent(agentId)),
    });
  }

  createWorkspace(input: CreateWorkspaceInput): Promise<string> {
    return this.execute(["create-workspace", input.key], input.request, {
      resource: { kind: "workspace", id: input.workspaceId },
      // A registry entry can survive failed provisioning and checkout rollback.
      // Only a completed receipt proves that the entire operation succeeded.
      recover: async () => false,
      run: input.create,
      retrySafe: async (workspaceId) => !(await input.findWorkspace(workspaceId)),
    });
  }

  async sendMessage(input: SendMessageInput): Promise<void> {
    await this.execute(["send", input.agentId, input.messageId], input.request, {
      resource: { kind: "agent", id: input.agentId },
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
      resource: Receipt["resource"];
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
      resource: Receipt["resource"];
      recover: (agentId: string) => Promise<boolean>;
      run: (agentId: string) => Promise<void>;
      prepare?: (() => Promise<void>) | undefined;
      retrySafe?: (agentId: string) => Promise<boolean>;
    },
  ): Promise<string> {
    const file = path.join(this.directory, `${key}.json`);
    const existing = await readReceipt(file);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new Error(`${operation.resource.kind}_request_key_conflict`);
      if (existing.state === "completed") return existing.resource.id;
      if (!(await operation.recover(existing.resource.id))) {
        throw new Error(`${operation.resource.kind}_request_outcome_unknown`);
      }
      await writeReceipt(file, { ...existing, state: "completed" });
      return existing.resource.id;
    }
    await operation.prepare?.();
    const receipt: Receipt = { fingerprint, resource: operation.resource, state: "pending" };
    await writeReceipt(file, receipt);
    try {
      await operation.run(receipt.resource.id);
    } catch (error) {
      // Once creation cleanup finished, absence of its persisted resource
      // confirms that retrying cannot duplicate it.
      if (await operation.retrySafe?.(receipt.resource.id)) await rm(file, { force: true });
      throw error;
    }
    await writeReceipt(file, { ...receipt, state: "completed" });
    return receipt.resource.id;
  }
}

async function readReceipt(file: string): Promise<Receipt | null> {
  try {
    const stored = ReceiptSchema.parse(JSON.parse(await readFile(file, "utf8")));
    return {
      fingerprint: stored.fingerprint,
      state: stored.state,
      resource:
        "agentId" in stored
          ? { kind: "agent", id: stored.agentId }
          : { kind: "workspace", id: stored.workspaceId },
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeReceipt(file: string, receipt: Receipt): Promise<void> {
  await writeJsonFileAtomic(file, {
    fingerprint: receipt.fingerprint,
    state: receipt.state,
    ...(receipt.resource.kind === "agent"
      ? { agentId: receipt.resource.id }
      : { workspaceId: receipt.resource.id }),
  });
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
