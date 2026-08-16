import { promises as fs } from "node:fs";

import type pino from "pino";
import { z } from "zod";

import { writeJsonFileAtomic } from "../../atomic-file.js";
import type { WorkspaceRuntimeRecordStore } from "../../workspace-runtime/index.js";

const ProbeRecordSchema = z
  .object({
    workspaceId: z.string(),
    projectId: z.string(),
    runtimeId: z.string(),
    fingerprint: z.string(),
    status: z.enum(["materializing", "ready", "paused", "destroying"]),
    lastUsedAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export type ProviderProbeRecord = z.infer<typeof ProbeRecordSchema>;

export interface ProbeStore {
  readonly records: WorkspaceRuntimeRecordStore;
  get(workspaceId: string): Promise<ProviderProbeRecord | null>;
  list(): Promise<readonly ProviderProbeRecord[]>;
  put(record: ProviderProbeRecord): Promise<void>;
  update(
    workspaceId: string,
    updater: (record: ProviderProbeRecord) => ProviderProbeRecord,
  ): Promise<ProviderProbeRecord | null>;
  remove(workspaceId: string): Promise<void>;
}

export function createProbeStore(filePath: string, logger: pino.Logger): ProbeStore {
  let loaded = false;
  let queue = Promise.resolve();
  const cache = new Map<string, ProviderProbeRecord>();
  const log = logger.child({ module: "provider-probe-store" });

  async function load(): Promise<void> {
    if (loaded) return;
    try {
      const records = z
        .array(ProbeRecordSchema)
        .parse(JSON.parse(await fs.readFile(filePath, "utf8")));
      for (const record of records) cache.set(record.workspaceId, record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        loaded = true;
        return;
      }
      log.error({ err: error, filePath }, "Failed to load provider probes");
      throw error;
    }
    loaded = true;
  }

  async function mutate<TResult>(
    operation: (draft: Map<string, ProviderProbeRecord>) => TResult,
  ): Promise<TResult> {
    await load();
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const draft = new Map(cache);
      const result = operation(draft);
      await writeJsonFileAtomic(filePath, [...draft.values()]);
      cache.clear();
      for (const [workspaceId, record] of draft) cache.set(workspaceId, record);
      return result;
    } finally {
      release();
    }
  }

  const store: ProbeStore = {
    records: {
      async resolveRuntimeId(workspaceId) {
        return (await store.get(workspaceId))?.runtimeId ?? null;
      },
      async persistRuntimeId(workspaceId, runtimeId) {
        const updated = await store.update(workspaceId, (record) => ({
          ...record,
          runtimeId,
          status: "ready",
        }));
        if (!updated) throw new Error(`Provider probe record not found: ${workspaceId}`);
      },
      async archiveWorkspaceRecord(workspaceId) {
        await store.update(workspaceId, (record) => ({ ...record, status: "paused" }));
      },
      async restoreWorkspaceRecord(workspaceId) {
        await store.update(workspaceId, (record) => ({ ...record, status: "ready" }));
      },
      async beginWorkspaceDeletion(workspaceId) {
        await store.update(workspaceId, (record) => ({ ...record, status: "destroying" }));
      },
      async removeWorkspaceRecord(workspaceId) {
        await store.remove(workspaceId);
      },
      async listRuntimeRecords() {
        await load();
        return [...cache.values()].map((record) => ({
          workspaceId: record.workspaceId,
          runtimeId: record.runtimeId,
          archived: record.status === "paused",
          deleting: record.status === "destroying",
        }));
      },
    },
    async get(workspaceId) {
      await load();
      return cache.get(workspaceId) ?? null;
    },
    async list() {
      await load();
      return [...cache.values()];
    },
    async put(record) {
      const parsed = ProbeRecordSchema.parse(record);
      await mutate((draft) => draft.set(parsed.workspaceId, parsed));
    },
    async update(workspaceId, updater) {
      return mutate((draft) => {
        const current = draft.get(workspaceId);
        if (!current) return null;
        const next = ProbeRecordSchema.parse(updater(current));
        draft.set(workspaceId, next);
        return next;
      });
    },
    async remove(workspaceId) {
      await mutate((draft) => draft.delete(workspaceId));
    },
  };
  return store;
}
