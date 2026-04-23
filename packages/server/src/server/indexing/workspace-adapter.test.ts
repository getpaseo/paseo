import { describe, it, expect } from "vitest";

import { createWorkspaceIndexingAdapter } from "./workspace-adapter.js";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "../workspace-registry.js";
import type { IndexingState } from "./types.js";

function baseRecord(overrides: Partial<PersistedWorkspaceRecord> = {}): PersistedWorkspaceRecord {
  return {
    workspaceId: "ws1",
    projectId: "p1",
    cwd: "/repos/p1",
    kind: "directory",
    displayName: "Project 1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function makeRegistry(seed: PersistedWorkspaceRecord[]): WorkspaceRegistry & {
  store: Map<string, PersistedWorkspaceRecord>;
} {
  const store = new Map(seed.map((r) => [r.workspaceId, r]));
  return {
    store,
    async initialize() {},
    async existsOnDisk() {
      return true;
    },
    async list() {
      return Array.from(store.values());
    },
    async get(workspaceId) {
      return store.get(workspaceId) ?? null;
    },
    async upsert(record) {
      store.set(record.workspaceId, record);
    },
    async archive(workspaceId, archivedAt) {
      const r = store.get(workspaceId);
      if (r) store.set(workspaceId, { ...r, archivedAt });
    },
    async remove(workspaceId) {
      store.delete(workspaceId);
    },
  };
}

const sampleIndexing: IndexingState = {
  enabled: true,
  watchlist: ["dist"],
  exposeTo: { codex: { enabled: true } },
  status: { phase: "ready", nodeCount: 12 },
};

describe("createWorkspaceIndexingAdapter", () => {
  it("lists every workspace, surfacing indexing field when present", async () => {
    const registry = makeRegistry([
      baseRecord({ workspaceId: "ws1", indexing: sampleIndexing }),
      baseRecord({ workspaceId: "ws2" }),
    ]);
    const adapter = createWorkspaceIndexingAdapter(registry, { dirExists: async () => true });
    const list = await adapter.list();
    expect(list).toEqual([
      { workspaceId: "ws1", indexing: sampleIndexing },
      { workspaceId: "ws2", indexing: undefined },
    ]);
  });

  it("returns null on get for unknown workspace", async () => {
    const adapter = createWorkspaceIndexingAdapter(makeRegistry([]), {
      dirExists: async () => true,
    });
    expect(await adapter.get("missing")).toBeNull();
  });

  it("setIndexing persists value and bumps updatedAt", async () => {
    const registry = makeRegistry([baseRecord({ workspaceId: "ws1" })]);
    const before = registry.store.get("ws1")?.updatedAt;
    const adapter = createWorkspaceIndexingAdapter(registry, { dirExists: async () => true });
    await new Promise((r) => setTimeout(r, 5));
    await adapter.setIndexing("ws1", sampleIndexing);
    const after = registry.store.get("ws1");
    expect(after?.indexing).toEqual(sampleIndexing);
    expect(after?.updatedAt).not.toBe(before);
  });

  it("setIndexing(null) clears the indexing field", async () => {
    const registry = makeRegistry([baseRecord({ workspaceId: "ws1", indexing: sampleIndexing })]);
    const adapter = createWorkspaceIndexingAdapter(registry, { dirExists: async () => true });
    await adapter.setIndexing("ws1", null);
    expect(registry.store.get("ws1")?.indexing).toBeUndefined();
  });

  it("throws when the target workspace is missing", async () => {
    const adapter = createWorkspaceIndexingAdapter(makeRegistry([]), {
      dirExists: async () => true,
    });
    await expect(adapter.setIndexing("missing", sampleIndexing)).rejects.toThrow(
      /unknown workspace/i,
    );
  });
});
