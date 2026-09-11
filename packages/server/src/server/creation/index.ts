import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  CreationSnapshotSchema,
  type AgentSnapshotPayload,
  type CreationSnapshot,
  type WorkspaceDescriptorPayload,
} from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { generateWorkspaceId } from "../workspace-registry-model.js";

type Observer = (snapshot: CreationSnapshot) => void;
export interface CreationInput {
  kind: "workspace" | "agent";
  key: string;
  request: unknown;
  workspaceId?: string;
  agentId?: string;
  hasAgent: boolean;
  hasPrompt: boolean;
  exists: (kind: "workspace" | "agent", id: string) => Promise<boolean>;
  provision?: (
    workspaceId: string,
  ) => Promise<{ workspace: WorkspaceDescriptorPayload; setupSkippedReason?: string }>;
  createAgent?: (
    agentId: string,
    workspace: WorkspaceDescriptorPayload | undefined,
    onReady: (agent: AgentSnapshotPayload) => Promise<void>,
  ) => Promise<AgentSnapshotPayload>;
}
const RecordSchema = z.object({
  fingerprint: z.string(),
  snapshot: CreationSnapshotSchema,
  inFlight: z.enum(["workspace", "agent", "prompt"]).nullable(),
});
type Record = z.infer<typeof RecordSchema>;

/** Owns creation across socket lifetimes. Resource owners perform work; this module commits its milestones. */
export class CreationService {
  private admission: Promise<unknown> = Promise.resolve();
  private readonly active = new Map<string, Promise<CreationSnapshot>>();
  private readonly observers = new Map<string, Set<Observer>>();
  constructor(
    private readonly directory: string,
    private readonly validateCompleted: (
      snapshot: CreationSnapshot,
    ) => Promise<void> = async () => {},
  ) {}

  async create(input: CreationInput, observer?: Observer): Promise<CreationSnapshot> {
    const identity = identityFor(input.kind, input.key);
    const admitted = this.admission.then(async () => {
      await mkdir(this.directory, { recursive: true });
      let record = await this.read(identity);
      const fingerprint = digest(input.request);
      if (record && record.fingerprint !== fingerprint)
        throw new Error(`${input.kind}_request_key_conflict`);
      const running = this.active.get(identity);
      if (running && record) return { completion: running, snapshot: record.snapshot };
      if (record?.snapshot.phase === "completed") await this.validateCompleted(record.snapshot);
      if (record?.snapshot.phase === "completed" || record?.snapshot.outcomeUnknown) {
        return { completion: Promise.resolve(record.snapshot), snapshot: record.snapshot };
      }
      if (record?.inFlight) {
        await this.publish(identity, record, {
          phase: "failed",
          error: `${input.kind}_request_outcome_unknown`,
          failedStage: record.inFlight,
          outcomeUnknown: true,
        });
        return { completion: Promise.resolve(record.snapshot), snapshot: record.snapshot };
      }
      if (!record) {
        record = initialRecord(input, fingerprint);
        // Persist identity before claiming resources. A failed admission can only retry these IDs.
        await this.write(identity, record);
      }
      await this.claimResources(identity, record.snapshot, input);
      if (record.snapshot.phase === "failed") {
        await this.publish(identity, record, {
          phase: record.snapshot.workspace ? "workspace_ready" : "accepted",
          error: null,
          errorCode: undefined,
          failedStage: undefined,
          outcomeUnknown: undefined,
        });
      }
      const snapshot = record.snapshot;
      // Defer the runner until admission has installed the initiating observer.
      const completion = Promise.resolve().then(() => this.run(identity, record, input));
      this.active.set(identity, completion);
      void completion.finally(() => this.active.delete(identity)).catch(() => undefined);
      return { completion, snapshot };
    });
    this.admission = admitted.then(
      () => undefined,
      () => undefined,
    );
    // Install before admission starts, so even a fast local provision cannot outrun observation.
    const unsubscribe = observer ? this.observe(identity, observer) : () => {};
    try {
      const { completion, snapshot } = await admitted;
      if (observer) this.notify(observer, snapshot);
      return await completion;
    } finally {
      unsubscribe();
    }
  }

  async subscribe(
    kind: CreationSnapshot["kind"],
    key: string,
    observer: Observer,
  ): Promise<{ snapshot: CreationSnapshot | null; unsubscribe: () => void }> {
    const identity = identityFor(kind, key);
    const unsubscribe = this.observe(identity, observer);
    try {
      await this.admission;
      const record = await this.read(identity);
      if (record?.inFlight && !this.active.has(identity)) {
        await this.publish(identity, record, {
          phase: "failed",
          failedStage: record.inFlight,
          outcomeUnknown: true,
          error: `${kind}_request_outcome_unknown`,
        });
      }
      if (record?.snapshot.phase === "completed") await this.validateCompleted(record.snapshot);
      return { snapshot: record?.snapshot ?? null, unsubscribe };
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  private async run(
    identity: string,
    record: Record,
    input: CreationInput,
  ): Promise<CreationSnapshot> {
    try {
      if (input.provision && !record.snapshot.workspace) {
        record.inFlight = "workspace";
        await this.write(identity, record);
        const { workspace, setupSkippedReason } = await input.provision(
          record.snapshot.workspaceId!,
        );
        record.inFlight = null;
        await this.publish(identity, record, {
          phase: "workspace_ready",
          workspace,
          workspaceId: workspace.id,
          setupSkippedReason,
        });
      }
      if (input.hasAgent && input.createAgent && !record.snapshot.agent) {
        record.inFlight = "agent";
        await this.write(identity, record);
        const agent = await input.createAgent(
          record.snapshot.agentId!,
          record.snapshot.workspace,
          async (readyAgent) => {
            record.inFlight = input.hasPrompt ? "prompt" : null;
            await this.publish(identity, record, {
              phase: "agent_ready",
              agent: readyAgent,
              workspaceId: readyAgent.workspaceId ?? record.snapshot.workspaceId,
            });
          },
        );
        record.inFlight = null;
        if (input.hasPrompt)
          await this.publish(identity, record, { phase: "prompt_started", agent });
        else record.snapshot = { ...record.snapshot, agent };
      }
      record.inFlight = null;
      await this.publish(identity, record, { phase: "completed" });
    } catch (error) {
      const stage = record.inFlight ?? "agent";
      const resourceId =
        stage === "workspace" ? record.snapshot.workspaceId : record.snapshot.agentId;
      const code =
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : undefined;
      const rejectedBeforeProvision = code === "directory_not_found" || code === "source_required";
      const unknown =
        stage === "prompt" ||
        (stage === "workspace" && !rejectedBeforeProvision) ||
        (resourceId !== null && (await input.exists(stage, resourceId)));
      // A failed provider startup with no registered resource can retry under the same ID.
      // A partially provisioned resource or an attempted prompt needs reconciliation.
      if (!unknown) record.inFlight = null;
      await this.publish(identity, record, {
        phase: "failed",
        error: error instanceof Error ? error.message : String(error),
        errorCode: code,
        failedStage: stage,
        outcomeUnknown: unknown,
      });
    }
    return record.snapshot;
  }

  private async claimResources(
    identity: string,
    snapshot: CreationSnapshot,
    input: CreationInput,
  ): Promise<void> {
    if (input.kind === "workspace" && snapshot.workspaceId)
      await this.claim(identity, "workspace", snapshot.workspaceId, input.exists);
    if (snapshot.agentId) await this.claim(identity, "agent", snapshot.agentId, input.exists);
  }

  private async claim(
    identity: string,
    kind: "workspace" | "agent",
    id: string,
    exists: CreationInput["exists"],
  ): Promise<void> {
    const file = join(this.directory, `${digest([kind, id])}.claim`);
    const owner = await readOptional(file);
    if (owner !== null) {
      if (owner !== identity) throw new Error(`${kind}_id_conflict`);
      return;
    }
    if (await exists(kind, id)) throw new Error(`${kind}_id_conflict`);
    await writeFile(file, identity, { flag: "wx", mode: 0o600 });
  }
  private observe(identity: string, observer: Observer): () => void {
    const observers = this.observers.get(identity) ?? new Set<Observer>();
    observers.add(observer);
    this.observers.set(identity, observers);
    return () => {
      observers.delete(observer);
      if (!observers.size) this.observers.delete(identity);
    };
  }
  private notify(observer: Observer, snapshot: CreationSnapshot): void {
    try {
      observer(snapshot);
    } catch {
      /* A disconnected observer cannot cancel accepted work. */
    }
  }
  private async publish(
    identity: string,
    record: Record,
    update: Partial<CreationSnapshot>,
  ): Promise<void> {
    record.snapshot = { ...record.snapshot, ...update, revision: record.snapshot.revision + 1 };
    await this.write(identity, record);
    for (const observer of this.observers.get(identity) ?? [])
      this.notify(observer, record.snapshot);
  }
  private write(identity: string, record: Record): Promise<void> {
    return writeJsonFileAtomic(join(this.directory, `${identity}.json`), record);
  }
  private async read(identity: string): Promise<Record | null> {
    const text = await readOptional(join(this.directory, `${identity}.json`));
    return text === null ? null : RecordSchema.parse(JSON.parse(text));
  }
}
function initialRecord(input: CreationInput, fingerprint: string): Record {
  return {
    fingerprint,
    inFlight: null,
    snapshot: {
      kind: input.kind,
      idempotencyKey: input.key,
      revision: 0,
      phase: "accepted",
      error: null,
      workspaceId: input.workspaceId ?? (input.kind === "workspace" ? generateWorkspaceId() : null),
      agentId: input.hasAgent ? (input.agentId ?? randomUUID()) : null,
    },
  };
}
function identityFor(kind: string, key: string): string {
  return digest([kind, key]);
}
function digest(input: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(input, (_key, value: unknown) => {
        if (value && typeof value === "object" && !Array.isArray(value))
          return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
        return value;
      }),
    )
    .digest("hex");
}
async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
