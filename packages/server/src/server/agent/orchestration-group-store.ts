import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";

export const OrchestrationTerminalStateSchema = z.enum([
  "completed",
  "failed",
  "cancelled",
  "held",
  "timed_out",
]);

export const OrchestrationGroupSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  lineageId: z.string().min(1),
  callerAgentId: z.string().min(1),
  workspaceId: z.string().min(1),
  repositoryId: z.string().nullable(),
  checkoutId: z.string().nullable(),
  expectedChildIds: z.array(z.string().min(1)),
  children: z.record(
    z.string(),
    z.object({
      terminalState: OrchestrationTerminalStateSchema.nullable(),
      eventKeys: z.array(z.string().min(1)),
      summary: z.string().nullable(),
      resultPointer: z.string().nullable(),
      terminalAt: z.string().nullable(),
    }),
  ),
  continuationPolicy: z.enum(["batch", "none"]),
  state: z.enum([
    "open",
    "sealed",
    "terminal",
    "continuation_claimed",
    "continued",
    "held",
    "expired",
  ]),
  maxSummaryCharsPerChild: z.number().int().min(256).max(4000),
  continuationKey: z.string().nullable(),
  continuationClaimedAt: z.string().nullable(),
  continuationTurnId: z.string().nullable(),
  holdReason: z.string().nullable(),
  createdAt: z.string(),
  sealedAt: z.string().nullable(),
  expiresAt: z.string(),
  updatedAt: z.string(),
});

export type OrchestrationGroup = z.infer<typeof OrchestrationGroupSchema>;
export type OrchestrationTerminalState = z.infer<typeof OrchestrationTerminalStateSchema>;

export interface CreateOrchestrationGroupInput {
  lineageId: string;
  callerAgentId: string;
  workspaceId: string;
  repositoryId?: string | null;
  checkoutId?: string | null;
  continuationPolicy: "batch" | "none";
  timeoutMs: number;
  maxSummaryCharsPerChild: number;
}

export interface RecordTerminalEventInput {
  agentId: string;
  eventKey: string;
  terminalState: OrchestrationTerminalState;
  summary: string | null;
  resultPointer: string | null;
}

/**
 * Durable, per-group mutation serialization. A continuation claim is written before a
 * dispatcher is allowed to run, making a process crash fail closed instead of retrying.
 */
export class OrchestrationGroupStore {
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async getUnsafe(id: string): Promise<OrchestrationGroup | null> {
    try {
      return OrchestrationGroupSchema.parse(JSON.parse(await readFile(this.path(id), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async write(group: OrchestrationGroup): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeJsonFileAtomic(this.path(group.id), group);
  }

  private mutate<T>(id: string, fn: (group: OrchestrationGroup) => T | Promise<T>): Promise<T> {
    const previous = this.pending.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
      const group = await this.getUnsafe(id);
      if (!group) throw new Error(`Orchestration group ${id} not found`);
      const result = await fn(group);
      await this.write(group);
      return result;
    });
    const tracked = next.finally(() => {
      if (this.pending.get(id) === tracked) this.pending.delete(id);
    });
    this.pending.set(id, tracked);
    return tracked;
  }

  async create(input: CreateOrchestrationGroupInput): Promise<OrchestrationGroup> {
    if (
      !Number.isInteger(input.timeoutMs) ||
      input.timeoutMs < 1000 ||
      input.timeoutMs > 86_400_000
    ) {
      throw new Error("timeoutMs must be an integer between 1,000 and 86,400,000");
    }
    if (
      !Number.isInteger(input.maxSummaryCharsPerChild) ||
      input.maxSummaryCharsPerChild < 256 ||
      input.maxSummaryCharsPerChild > 4000
    ) {
      throw new Error("maxSummaryCharsPerChild must be an integer between 256 and 4,000");
    }
    const createdAt = this.now().toISOString();
    const group = OrchestrationGroupSchema.parse({
      schemaVersion: 1,
      id: randomUUID(),
      ...input,
      repositoryId: input.repositoryId ?? null,
      checkoutId: input.checkoutId ?? null,
      expectedChildIds: [],
      children: {},
      state: "open",
      continuationKey: null,
      continuationClaimedAt: null,
      continuationTurnId: null,
      holdReason: null,
      createdAt,
      sealedAt: null,
      expiresAt: new Date(this.now().getTime() + input.timeoutMs).toISOString(),
      updatedAt: createdAt,
    });
    await this.write(group);
    return group;
  }

  async get(id: string): Promise<OrchestrationGroup | null> {
    return this.getUnsafe(id);
  }

  async registerChild(id: string, agentId: string): Promise<OrchestrationGroup> {
    return this.mutate(id, (group) => {
      if (group.state !== "open")
        throw new Error("Cannot register a child after a group is sealed");
      if (!group.children[agentId]) {
        group.expectedChildIds.push(agentId);
        group.children[agentId] = {
          terminalState: null,
          eventKeys: [],
          summary: null,
          resultPointer: null,
          terminalAt: null,
        };
      }
      group.updatedAt = this.now().toISOString();
      return group;
    });
  }

  async seal(id: string): Promise<OrchestrationGroup> {
    return this.mutate(id, (group) => {
      if (group.state === "open") {
        group.state = "sealed";
        group.sealedAt = this.now().toISOString();
      }
      this.evaluateTerminal(group);
      group.updatedAt = this.now().toISOString();
      return group;
    });
  }

  async recordTerminalEvent(
    id: string,
    input: RecordTerminalEventInput,
  ): Promise<{
    group: OrchestrationGroup;
    recorded: boolean;
  }> {
    return this.mutate(id, (group) => {
      const child = group.children[input.agentId];
      if (!child) throw new Error("Child is not registered in this orchestration group");
      if (child.eventKeys.includes(input.eventKey)) return { group, recorded: false };
      child.eventKeys.push(input.eventKey);
      // First terminal event wins. Later provider observations are retained as keys only.
      if (child.terminalState === null) {
        child.terminalState = input.terminalState;
        child.summary = input.summary?.slice(0, group.maxSummaryCharsPerChild) ?? null;
        child.resultPointer = input.resultPointer;
        child.terminalAt = this.now().toISOString();
      }
      this.evaluateTerminal(group);
      group.updatedAt = this.now().toISOString();
      return { group, recorded: true };
    });
  }

  async claimContinuation(id: string): Promise<{ group: OrchestrationGroup; claimed: boolean }> {
    return this.mutate(id, (group) => {
      this.evaluateTerminal(group);
      if (
        (group.state !== "terminal" && group.state !== "expired") ||
        group.continuationPolicy !== "batch"
      ) {
        return { group, claimed: false };
      }
      group.state = "continuation_claimed";
      group.continuationKey = `${group.id}:completion`;
      group.continuationClaimedAt = this.now().toISOString();
      group.updatedAt = this.now().toISOString();
      return { group, claimed: true };
    });
  }

  async confirmContinuation(id: string, turnId: string): Promise<OrchestrationGroup> {
    return this.mutate(id, (group) => {
      if (group.state !== "continuation_claimed") throw new Error("Continuation was not claimed");
      group.state = "continued";
      group.continuationTurnId = turnId;
      group.updatedAt = this.now().toISOString();
      return group;
    });
  }

  async recoverUnconfirmedClaims(): Promise<OrchestrationGroup[]> {
    await mkdir(this.dir, { recursive: true });
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(this.dir);
    const held: OrchestrationGroup[] = [];
    for (const file of files.filter((entry) => entry.endsWith(".json"))) {
      const id = file.slice(0, -5);
      const result = await this.mutate(id, (group) => {
        if (group.state === "continuation_claimed" && !group.continuationTurnId) {
          group.state = "held";
          group.holdReason = "continuation_dispatch_unknown";
          group.updatedAt = this.now().toISOString();
          held.push(group);
        }
        return group;
      });
      void result;
    }
    return held;
  }

  private evaluateTerminal(group: OrchestrationGroup): void {
    if (group.state !== "sealed") return;
    const expired = new Date(group.expiresAt).getTime() <= this.now().getTime();
    const allTerminal = group.expectedChildIds.every(
      (id) => group.children[id]?.terminalState !== null,
    );
    if (!expired && !allTerminal) return;
    if (expired) {
      for (const id of group.expectedChildIds) {
        const child = group.children[id]!;
        if (child.terminalState === null) {
          child.terminalState = "timed_out";
          child.terminalAt = this.now().toISOString();
        }
      }
      group.state = "expired";
    } else {
      group.state = "terminal";
    }
  }
}
