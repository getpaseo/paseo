import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";

import { Session } from "./session.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

describe("snapshot mutation ownership boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("daemon live mutations write one durable snapshot through the manager-owned path", async () => {
    const daemonHandle = await createTestPaseoDaemon();
    const cwd = mkdtempSync(path.join(os.tmpdir(), "snapshot-owner-live-"));

    try {
      const snapshot = await daemonHandle.daemon.agentManager.createAgent({
        provider: "codex",
        cwd,
        model: "gpt-5.2-codex",
      });
      await daemonHandle.daemon.agentManager.flush();

      const applySnapshotSpy = vi.spyOn(daemonHandle.daemon.agentStorage, "applySnapshot");

      await daemonHandle.daemon.agentManager.setAgentModel(snapshot.id, "gpt-5.4");
      await daemonHandle.daemon.agentManager.flush();

      expect(applySnapshotSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

      const persisted = await daemonHandle.daemon.agentStorage.get(snapshot.id);
      expect(persisted?.config?.model).toBe("gpt-5.4");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      await daemonHandle.close();
    }
  });

  test("session runtime flows delegate snapshot mutations to agent manager without direct storage writes", async () => {
    const onMessage = vi.fn();
    const storedRecord = {
      id: "agent-1",
      provider: "codex",
      cwd: "/tmp/project",
      createdAt: "2026-03-24T00:00:00.000Z",
      updatedAt: "2026-03-24T00:00:00.000Z",
      title: null,
      labels: {},
      lastStatus: "idle" as const,
      config: null,
      persistence: null,
      archivedAt: null as string | null,
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
    };
    const archiveSnapshot = vi.fn(async (_agentId: string, archivedAt: string) => {
      storedRecord.archivedAt = archivedAt;
      storedRecord.updatedAt = archivedAt;
      return {
        ...storedRecord,
        archivedAt,
        updatedAt: archivedAt,
      };
    });
    const updateAgentMetadata = vi.fn(async () => undefined);
    const directStorageWrite = vi.fn(async () => {
      throw new Error("Session should not write snapshots directly");
    });

    const logger = {
      child: () => logger,
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const session = new Session({
      clientId: "test-client",
      onMessage,
      logger: logger as any,
      downloadTokenStore: {} as any,
      pushTokenStore: {} as any,
      paseoHome: "/tmp/paseo-test",
      agentManager: {
        subscribe: () => () => {},
        listAgents: () => [],
        getAgent: () => null,
        archiveSnapshot,
        updateAgentMetadata,
      } as any,
      agentStorage: {
        list: async () => [],
        get: async () => storedRecord,
        applySnapshot: directStorageWrite,
        upsert: directStorageWrite,
      } as any,
      projectRegistry: {
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => [],
        get: async () => null,
        upsert: async () => {},
        archive: async () => {},
        remove: async () => {},
      } as any,
      workspaceRegistry: {
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => [],
        get: async () => null,
        upsert: async () => {},
        archive: async () => {},
        remove: async () => {},
      } as any,
      createAgentMcpTransport: async () => {
        throw new Error("not used");
      },
      stt: null,
      tts: null,
      terminalManager: null,
    }) as any;

    const archiveResult = await session.archiveAgentForClose("agent-1");
    expect(archiveSnapshot).toHaveBeenCalledTimes(1);
    expect(archiveResult.archivedAt).toBeTruthy();

    await session.handleUpdateAgentRequest(
      "agent-1",
      "Renamed agent",
      { lane: "phase-1a" },
      "req-1",
    );
    expect(updateAgentMetadata).toHaveBeenCalledWith("agent-1", {
      title: "Renamed agent",
      labels: { lane: "phase-1a" },
    });
    expect(onMessage).toHaveBeenCalledWith({
      type: "update_agent_response",
      payload: {
        requestId: "req-1",
        agentId: "agent-1",
        accepted: true,
        error: null,
      },
    });

    expect(directStorageWrite).not.toHaveBeenCalled();
  });
});
