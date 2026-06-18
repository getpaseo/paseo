import { homedir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { AgentStorage } from "../agent/agent-storage.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  FileBackedWorkspaceRegistry,
  createPersistedWorkspaceRecord,
} from "../workspace-registry.js";
import { backfillWorkspaceIdForLegacyAgents } from "./backfill-workspace-id.migration.js";

function workspaceRecord(
  cwd: string,
  workspaceId: string,
  overrides?: { createdAt?: string; archivedAt?: string },
) {
  return createPersistedWorkspaceRecord({
    workspaceId,
    projectId: workspaceId,
    cwd,
    kind: "directory",
    displayName: path.basename(cwd) || cwd,
    createdAt: overrides?.createdAt ?? "2026-03-01T00:00:00.000Z",
    updatedAt: overrides?.createdAt ?? "2026-03-01T00:00:00.000Z",
    archivedAt: overrides?.archivedAt ?? null,
  });
}

describe("backfillWorkspaceIdForLegacyAgents", () => {
  let home: string;
  let agentStorage: AgentStorage;
  let workspaceRegistry: FileBackedWorkspaceRegistry;

  beforeEach(async () => {
    home = mkdtempSync(path.join(tmpdir(), "paseo-backfill-"));
    agentStorage = new AgentStorage(path.join(home, "agents"), createTestLogger());
    await agentStorage.initialize();
    workspaceRegistry = new FileBackedWorkspaceRegistry(
      path.join(home, "workspaces.json"),
      createTestLogger(),
    );
    await workspaceRegistry.initialize();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  async function seedLegacyAgent(cwd: string, id: string): Promise<void> {
    await agentStorage.upsert({
      id,
      provider: "codex",
      cwd,
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
      lastActivityAt: "2026-03-01T12:00:00.000Z",
      lastUserMessageAt: null,
      title: null,
      labels: {},
      lastStatus: "closed",
      lastModeId: null,
      config: null,
      runtimeInfo: { provider: "codex", sessionId: null },
      persistence: null,
      archivedAt: null,
    });
  }

  test("stamps the oldest exact-cwd workspace onto an unstamped legacy agent", async () => {
    await workspaceRegistry.upsert(
      workspaceRecord("/tmp/repo", "ws-newer", { createdAt: "2026-03-02T00:00:00.000Z" }),
    );
    await workspaceRegistry.upsert(
      workspaceRecord("/tmp/repo", "ws-older", { createdAt: "2026-03-01T00:00:00.000Z" }),
    );
    await seedLegacyAgent("/tmp/repo", "legacy-agent");

    const migrated = await backfillWorkspaceIdForLegacyAgents({
      agentStorage,
      workspaceRegistry,
      logger: createTestLogger(),
    });

    expect(migrated).toBe(1);
    expect((await agentStorage.get("legacy-agent"))?.workspaceId).toBe("ws-older");
  });

  test("attributes to the deepest enclosing workspace when there is no exact match", async () => {
    await workspaceRegistry.upsert(workspaceRecord("/tmp/repo", "ws-root"));
    await workspaceRegistry.upsert(workspaceRecord("/tmp/repo/packages/app", "ws-app"));
    await seedLegacyAgent("/tmp/repo/packages/app/src", "legacy-agent");

    await backfillWorkspaceIdForLegacyAgents({
      agentStorage,
      workspaceRegistry,
      logger: createTestLogger(),
    });

    expect((await agentStorage.get("legacy-agent"))?.workspaceId).toBe("ws-app");
  });

  test("leaves already-stamped records untouched", async () => {
    await workspaceRegistry.upsert(workspaceRecord("/tmp/repo", "ws-cwd"));
    await agentStorage.upsert({
      id: "stamped-agent",
      provider: "codex",
      cwd: "/tmp/repo",
      workspaceId: "ws-explicit",
      createdAt: "2026-03-01T12:00:00.000Z",
      updatedAt: "2026-03-01T12:00:00.000Z",
      lastActivityAt: "2026-03-01T12:00:00.000Z",
      lastUserMessageAt: null,
      title: null,
      labels: {},
      lastStatus: "closed",
      lastModeId: null,
      config: null,
      runtimeInfo: { provider: "codex", sessionId: null },
      persistence: null,
      archivedAt: null,
    });

    const migrated = await backfillWorkspaceIdForLegacyAgents({
      agentStorage,
      workspaceRegistry,
      logger: createTestLogger(),
    });

    expect(migrated).toBe(0);
    expect((await agentStorage.get("stamped-agent"))?.workspaceId).toBe("ws-explicit");
  });

  test("does not let the home directory own descendants", async () => {
    const userHome = homedir();
    await workspaceRegistry.upsert(workspaceRecord(userHome, "ws-home"));
    await seedLegacyAgent(path.join(userHome, "repo"), "legacy-agent");

    const migrated = await backfillWorkspaceIdForLegacyAgents({
      agentStorage,
      workspaceRegistry,
      logger: createTestLogger(),
    });

    expect(migrated).toBe(0);
    expect((await agentStorage.get("legacy-agent"))?.workspaceId).toBeUndefined();
  });
});
