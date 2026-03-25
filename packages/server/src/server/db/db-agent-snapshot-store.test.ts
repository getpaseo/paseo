import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { ManagedAgent } from "../agent/agent-manager.js";
import type {
  AgentPermissionRequest,
  AgentSession,
  AgentSessionConfig,
} from "../agent/agent-sdk-types.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import { openPaseoDatabase, type PaseoDatabaseHandle } from "./pglite-database.js";
import { DbAgentSnapshotStore } from "./db-agent-snapshot-store.js";
import { agentSnapshots, projects, workspaces } from "./schema.js";

type ManagedAgentOverrides = Omit<
  Partial<ManagedAgent>,
  "config" | "pendingPermissions" | "session" | "activeForegroundTurnId"
> & {
  config?: Partial<AgentSessionConfig>;
  pendingPermissions?: Map<string, AgentPermissionRequest>;
  session?: AgentSession | null;
  activeForegroundTurnId?: string | null;
  runtimeInfo?: ManagedAgent["runtimeInfo"];
  attention?: ManagedAgent["attention"];
};

function createManagedAgent(overrides: ManagedAgentOverrides = {}): ManagedAgent {
  const now = overrides.updatedAt ?? new Date("2026-03-01T00:00:00.000Z");
  const provider = overrides.provider ?? "codex";
  const cwd = overrides.cwd ?? "/tmp/project";
  const lifecycle = overrides.lifecycle ?? "idle";
  const configOverrides = overrides.config ?? {};
  const config: AgentSessionConfig = {
    provider,
    cwd,
    title: configOverrides.title,
    modeId: configOverrides.modeId ?? "plan",
    model: configOverrides.model ?? "gpt-5.1-codex-mini",
    extra: configOverrides.extra ?? { codex: { approvalPolicy: "on-request" } },
    systemPrompt: configOverrides.systemPrompt,
    mcpServers: configOverrides.mcpServers,
  };
  const session = lifecycle === "closed" ? null : (overrides.session ?? ({} as AgentSession));
  const activeForegroundTurnId =
    overrides.activeForegroundTurnId ?? (lifecycle === "running" ? "turn-1" : null);

  return {
    id: overrides.id ?? "agent-1",
    provider,
    cwd,
    session,
    capabilities: overrides.capabilities ?? {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    config,
    lifecycle,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    availableModes: overrides.availableModes ?? [],
    currentModeId: overrides.currentModeId ?? config.modeId ?? null,
    pendingPermissions: overrides.pendingPermissions ?? new Map<string, AgentPermissionRequest>(),
    activeForegroundTurnId,
    foregroundTurnWaiters: new Set(),
    unsubscribeSession: null,
    timeline: overrides.timeline ?? [],
    attention: overrides.attention ?? { requiresAttention: false },
    runtimeInfo: overrides.runtimeInfo ?? {
      provider,
      sessionId: overrides.sessionId ?? "session-123",
      model: config.model ?? null,
      modeId: config.modeId ?? null,
    },
    persistence: overrides.persistence ?? null,
    historyPrimed: overrides.historyPrimed ?? true,
    lastUserMessageAt: overrides.lastUserMessageAt ?? now,
    lastUsage: overrides.lastUsage,
    lastError: overrides.lastError,
    internal: overrides.internal,
    labels: overrides.labels ?? {},
    pendingReplacement: false,
    provisionalAssistantText: null,
  };
}

function createStoredAgentRecord(overrides: Partial<StoredAgentRecord> = {}): StoredAgentRecord {
  return {
    id: "agent-1",
    provider: "codex",
    cwd: "/tmp/project",
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    lastActivityAt: "2026-03-01T00:00:00.000Z",
    lastUserMessageAt: null,
    title: null,
    labels: {},
    lastStatus: "idle",
    lastModeId: "plan",
    config: {
      modeId: "plan",
      model: "gpt-5.1-codex-mini",
    },
    runtimeInfo: {
      provider: "codex",
      sessionId: "session-123",
      model: "gpt-5.1-codex-mini",
      modeId: "plan",
    },
    persistence: {
      provider: "codex",
      sessionId: "session-123",
    },
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    internal: false,
    archivedAt: null,
    ...overrides,
  };
}

describe("DbAgentSnapshotStore", () => {
  let tmpDir: string;
  let dataDir: string;
  let database: PaseoDatabaseHandle;
  let store: DbAgentSnapshotStore;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-agent-snapshot-store-"));
    dataDir = path.join(tmpDir, "db");
    database = await openPaseoDatabase(dataDir);
    store = new DbAgentSnapshotStore(database.db);
    await store.initialize();
  });

  afterEach(async () => {
    await database.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("supports list/get/upsert/remove CRUD lifecycle", async () => {
    await seedWorkspace(database, { workspaceId: "/tmp/project", projectId: "project-1" });

    const record = createStoredAgentRecord();

    expect(await store.list()).toEqual([]);
    expect(await store.get(record.id)).toBeNull();

    await store.upsert(record);

    expect(await store.get(record.id)).toEqual(record);
    expect(await store.list()).toEqual([record]);
    expect(await database.db.select().from(agentSnapshots)).toEqual([
      expect.objectContaining({
        agentId: "agent-1",
        workspaceId: "/tmp/project",
        requiresAttention: false,
        internal: false,
      }),
    ]);

    await store.remove(record.id);

    expect(await store.get(record.id)).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  test("applySnapshot preserves title, createdAt, and archivedAt across updates", async () => {
    await store.upsert(
      createStoredAgentRecord({
        id: "agent-apply",
        title: "Pinned title",
        createdAt: "2026-03-01T00:00:00.000Z",
        archivedAt: "2026-03-05T00:00:00.000Z",
      }),
    );

    await store.applySnapshot(
      createManagedAgent({
        id: "agent-apply",
        createdAt: new Date("2026-03-10T00:00:00.000Z"),
        updatedAt: new Date("2026-03-11T00:00:00.000Z"),
        lifecycle: "running",
      }),
    );

    expect(await store.get("agent-apply")).toEqual(
      expect.objectContaining({
        id: "agent-apply",
        title: "Pinned title",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-11T00:00:00.000Z",
        archivedAt: "2026-03-05T00:00:00.000Z",
        lastStatus: "running",
      }),
    );
  });

  test("setTitle throws for missing agents and updates existing agents", async () => {
    await expect(store.setTitle("missing-agent", "Missing")).rejects.toThrow(
      "Agent missing-agent not found",
    );

    await store.upsert(createStoredAgentRecord({ id: "agent-title", title: null }));
    await store.setTitle("agent-title", "Renamed agent");

    expect(await store.get("agent-title")).toEqual(
      expect.objectContaining({
        id: "agent-title",
        title: "Renamed agent",
      }),
    );
  });

  test("beginDelete and flush are safe no-ops", async () => {
    await store.upsert(createStoredAgentRecord({ id: "agent-noop" }));

    expect(() => store.beginDelete("agent-noop")).not.toThrow();
    await expect(store.flush()).resolves.toBeUndefined();
    expect(await store.get("agent-noop")).toEqual(
      expect.objectContaining({
        id: "agent-noop",
      }),
    );
  });

  test("upsert is idempotent for the same agent ID", async () => {
    await store.upsert(createStoredAgentRecord({ id: "agent-idempotent", title: "Initial" }));
    await store.upsert(
      createStoredAgentRecord({
        id: "agent-idempotent",
        title: "Updated",
        updatedAt: "2026-03-02T00:00:00.000Z",
        lastStatus: "running",
      }),
    );

    expect(await store.list()).toEqual([
      createStoredAgentRecord({
        id: "agent-idempotent",
        title: "Updated",
        updatedAt: "2026-03-02T00:00:00.000Z",
        lastStatus: "running",
      }),
    ]);
    expect(await database.db.select().from(agentSnapshots)).toHaveLength(1);
  });
});

async function seedWorkspace(
  database: PaseoDatabaseHandle,
  options: { workspaceId: string; projectId: string },
): Promise<void> {
  await database.db.insert(projects).values({
    projectId: options.projectId,
    rootPath: options.workspaceId,
    kind: "git",
    displayName: options.projectId,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
  });
  await database.db.insert(workspaces).values({
    workspaceId: options.workspaceId,
    projectId: options.projectId,
    cwd: options.workspaceId,
    kind: "local_checkout",
    displayName: "main",
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
  });
}
