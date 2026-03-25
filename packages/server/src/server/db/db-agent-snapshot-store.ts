import { asc, eq } from "drizzle-orm";

import type { ManagedAgent } from "../agent/agent-manager.js";
import type { AgentSnapshotStore } from "../agent/agent-snapshot-store.js";
import { toStoredAgentRecord } from "../agent/agent-projections.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import { normalizeWorkspaceId } from "../workspace-registry-model.js";
import type { PaseoDatabaseHandle } from "./pglite-database.js";
import { agentSnapshots, workspaces } from "./schema.js";

type AgentSnapshotRow = typeof agentSnapshots.$inferSelect;
type AgentSnapshotInsert = typeof agentSnapshots.$inferInsert;

export function toStoredAgentRecordFromRow(row: AgentSnapshotRow): StoredAgentRecord {
  return {
    id: row.agentId,
    provider: row.provider,
    cwd: row.cwd,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActivityAt: row.lastActivityAt ?? undefined,
    lastUserMessageAt: row.lastUserMessageAt ?? null,
    title: row.title ?? null,
    labels: row.labels,
    lastStatus: row.lastStatus as StoredAgentRecord["lastStatus"],
    lastModeId: row.lastModeId ?? null,
    config: row.config ?? null,
    runtimeInfo: row.runtimeInfo ?? undefined,
    persistence: row.persistence ?? null,
    requiresAttention: row.requiresAttention,
    attentionReason: (row.attentionReason ?? null) as StoredAgentRecord["attentionReason"],
    attentionTimestamp: row.attentionTimestamp ?? null,
    internal: row.internal,
    archivedAt: row.archivedAt ?? null,
  };
}

export function toAgentSnapshotRowValues(options: {
  record: StoredAgentRecord;
  workspaceId: string | null;
}): AgentSnapshotInsert {
  const { record, workspaceId } = options;
  return {
    agentId: record.id,
    provider: record.provider,
    workspaceId,
    cwd: record.cwd,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastActivityAt: record.lastActivityAt ?? null,
    lastUserMessageAt: record.lastUserMessageAt ?? null,
    title: record.title ?? null,
    labels: record.labels,
    lastStatus: record.lastStatus,
    lastModeId: record.lastModeId ?? null,
    config: record.config ?? null,
    runtimeInfo: record.runtimeInfo ?? null,
    persistence: record.persistence ?? null,
    requiresAttention: record.requiresAttention ?? false,
    attentionReason: record.attentionReason ?? null,
    attentionTimestamp: record.attentionTimestamp ?? null,
    internal: record.internal ?? false,
    archivedAt: record.archivedAt ?? null,
  };
}

function toAgentSnapshotUpdateSet(values: AgentSnapshotInsert) {
  return {
    provider: values.provider,
    workspaceId: values.workspaceId,
    cwd: values.cwd,
    createdAt: values.createdAt,
    updatedAt: values.updatedAt,
    lastActivityAt: values.lastActivityAt,
    lastUserMessageAt: values.lastUserMessageAt,
    title: values.title,
    labels: values.labels,
    lastStatus: values.lastStatus,
    lastModeId: values.lastModeId,
    config: values.config,
    runtimeInfo: values.runtimeInfo,
    persistence: values.persistence,
    requiresAttention: values.requiresAttention,
    attentionReason: values.attentionReason,
    attentionTimestamp: values.attentionTimestamp,
    internal: values.internal,
    archivedAt: values.archivedAt,
  } satisfies Omit<AgentSnapshotInsert, "agentId">;
}

export class DbAgentSnapshotStore implements AgentSnapshotStore {
  private readonly db: PaseoDatabaseHandle["db"];

  constructor(db: PaseoDatabaseHandle["db"]) {
    this.db = db;
  }

  async initialize(): Promise<void> {
    return Promise.resolve();
  }

  async list(): Promise<StoredAgentRecord[]> {
    const rows = await this.db
      .select()
      .from(agentSnapshots)
      .orderBy(asc(agentSnapshots.createdAt), asc(agentSnapshots.agentId));
    return rows.map(toStoredAgentRecordFromRow);
  }

  async get(agentId: string): Promise<StoredAgentRecord | null> {
    const rows = await this.db
      .select()
      .from(agentSnapshots)
      .where(eq(agentSnapshots.agentId, agentId))
      .limit(1);
    const row = rows[0];
    return row ? toStoredAgentRecordFromRow(row) : null;
  }

  async upsert(record: StoredAgentRecord): Promise<void> {
    const values = toAgentSnapshotRowValues({
      record,
      workspaceId: await this.resolveWorkspaceId(record.cwd),
    });

    await this.db
      .insert(agentSnapshots)
      .values(values)
      .onConflictDoUpdate({
        target: agentSnapshots.agentId,
        set: toAgentSnapshotUpdateSet(values),
      });
  }

  beginDelete(_agentId: string): void {}

  async remove(agentId: string): Promise<void> {
    await this.db.delete(agentSnapshots).where(eq(agentSnapshots.agentId, agentId));
  }

  async applySnapshot(
    agent: ManagedAgent,
    options?: { title?: string | null; internal?: boolean },
  ): Promise<void> {
    const existing = await this.get(agent.id);
    const hasTitleOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "title");
    const hasInternalOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "internal");
    const record = toStoredAgentRecord(agent, {
      title: hasTitleOverride ? (options?.title ?? null) : (existing?.title ?? null),
      createdAt: existing?.createdAt,
      internal: hasInternalOverride ? options?.internal : (agent.internal ?? existing?.internal),
    });

    if (existing && existing.archivedAt !== undefined) {
      record.archivedAt = existing.archivedAt;
    }

    await this.upsert(record);
  }

  async setTitle(agentId: string, title: string): Promise<void> {
    const record = await this.get(agentId);
    if (!record) {
      throw new Error(`Agent ${agentId} not found`);
    }
    await this.upsert({ ...record, title });
  }

  async flush(): Promise<void> {
    return Promise.resolve();
  }

  private async resolveWorkspaceId(cwd: string): Promise<string | null> {
    const workspaceId = normalizeWorkspaceId(cwd);
    const rows = await this.db
      .select({ workspaceId: workspaces.workspaceId })
      .from(workspaces)
      .where(eq(workspaces.workspaceId, workspaceId))
      .limit(1);
    return rows[0]?.workspaceId ?? null;
  }
}
