import { createServer, type Server as HTTPServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage, type StoredAgentRecord } from "./agent/agent-storage.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import type { FileBackedChatService } from "./chat/chat-service.js";
import { DaemonConfigStore } from "./daemon-config-store.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import type { LoopService } from "./loop-service.js";
import type { ScheduleService } from "./schedule/service.js";
import { createStub } from "./test-utils/class-mocks.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import type { WorkspaceAutoName } from "./workspace-auto-name.js";

interface ProviderRenameHarness {
  configStore: DaemonConfigStore;
  agentStorage: AgentStorage;
  renameProviderOnLiveAgents: ReturnType<typeof vi.fn>;
  stop(): Promise<void>;
}

const harnesses: ProviderRenameHarness[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.stop()));
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function storedRecord(overrides: Partial<StoredAgentRecord>): StoredAgentRecord {
  return {
    id: "agent-1",
    provider: "claude-work",
    cwd: "/tmp/project",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    labels: {},
    lastStatus: "closed",
    config: null,
    runtimeInfo: { provider: "claude-work", sessionId: "session-1" },
    persistence: { provider: "claude-work", sessionId: "session-1" },
    ...overrides,
  };
}

function createWebSocketServer(params: {
  httpServer: HTTPServer;
  paseoHome: string;
  agentStorage: AgentStorage;
  configStore: DaemonConfigStore;
  renameProviderOnLiveAgents: ReturnType<typeof vi.fn>;
}): VoiceAssistantWebSocketServer {
  const agentManager = {
    setAgentAttentionCallback() {},
    subscribe: () => () => {},
    updateProviderRegistry() {},
    renameProviderOnLiveAgents: params.renameProviderOnLiveAgents,
    getMetricsSnapshot: () => ({
      total: 0,
      byLifecycle: {},
      withActiveForegroundTurn: 0,
      timelineStats: { totalItems: 0, maxItemsPerAgent: 0 },
    }),
  };

  return new VoiceAssistantWebSocketServer(
    params.httpServer,
    createStub<pino.Logger>(createTestLogger()),
    "srv-test",
    createStub<AgentManager>(agentManager),
    params.agentStorage,
    createStub<DownloadTokenStore>({}),
    params.paseoHome,
    params.configStore,
    null,
    { allowedOrigins: new Set(["*"]) },
    createStub<WorkspaceAutoName>({
      scheduleForWorktree: () => {},
      scheduleForDirectory: () => {},
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    "1.2.3-test",
    undefined,
    undefined,
    undefined,
    createStub<FileBackedChatService>({}),
    createStub<LoopService>({}),
    createStub<ScheduleService>({}),
    createStub<CheckoutDiffManager>({
      subscribe: () => {},
      scheduleRefreshForCwd: () => {},
      getMetrics: () => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      }),
      dispose: () => {},
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    createProviderSnapshotManagerStub().manager,
  );
}

async function startHarness(): Promise<ProviderRenameHarness> {
  const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-provider-rename-"));
  tempDirs.push(paseoHome);

  const agentStorage = new AgentStorage(path.join(paseoHome, "agents"), createTestLogger());
  const configStore = new DaemonConfigStore(paseoHome, {
    mcp: { injectIntoAgents: false },
    browserTools: { enabled: false },
    providers: { "claude-work": { extends: "claude", label: "Work" } },
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
  });
  const renameProviderOnLiveAgents = vi.fn();

  const httpServer = createServer();
  const wsServer = createWebSocketServer({
    httpServer,
    paseoHome,
    agentStorage,
    configStore,
    renameProviderOnLiveAgents,
  });

  const harness: ProviderRenameHarness = {
    configStore,
    agentStorage,
    renameProviderOnLiveAgents,
    async stop() {
      await wsServer.close();
      httpServer.close();
    },
  };
  harnesses.push(harness);
  return harness;
}

describe("provider rename migration wiring", () => {
  it("migrates persisted agents and repoints live agents when a provider is renamed", async () => {
    const harness = await startHarness();
    await harness.agentStorage.upsert(storedRecord({ id: "agent-renamed" }));
    await harness.agentStorage.upsert(
      storedRecord({
        id: "agent-other",
        provider: "claude",
        runtimeInfo: { provider: "claude", sessionId: "session-2" },
        persistence: { provider: "claude", sessionId: "session-2" },
      }),
    );

    harness.configStore.patch({
      replaceProviders: { "claude-job": { extends: "claude", label: "Job" } },
      removeProviders: ["claude-work"],
      renameProviders: { "claude-work": "claude-job" },
    });

    expect(harness.renameProviderOnLiveAgents).toHaveBeenCalledWith("claude-work", "claude-job");

    await vi.waitFor(async () => {
      const record = await harness.agentStorage.get("agent-renamed");
      expect(record?.provider).toBe("claude-job");
    });

    const record = await harness.agentStorage.get("agent-renamed");
    expect(record?.runtimeInfo?.provider).toBe("claude-job");
    expect(record?.persistence?.provider).toBe("claude-job");

    const other = await harness.agentStorage.get("agent-other");
    expect(other?.provider).toBe("claude");
  });
});
