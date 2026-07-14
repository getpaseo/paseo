import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { AgentManager } from "../agent/agent-manager.js";
import type {
  AgentClient,
  AgentCreateSessionOptions,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { ProviderUsageService } from "../../services/quota-fetcher/service.js";
import { Session } from "../session.js";
import { WorkspaceAutoName } from "../workspace-auto-name.js";
import { FileBackedProjectRegistry, FileBackedWorkspaceRegistry } from "../workspace-registry.js";
import {
  asChatService,
  asCheckoutDiffManager,
  asDaemonConfigStore,
  asDownloadTokenStore,
  asLoopService,
  asPushTokenStore,
  asScheduleService,
  createProviderSnapshotManagerStub,
} from "./session-stubs.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createNoopWorkspaceGitService } from "./workspace-git-service-stub.js";

const CREATE_AGENT_TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

class ChatWorkspaceFixtureTestSession implements AgentSession {
  readonly provider = "codex";
  readonly capabilities = CREATE_AGENT_TEST_CAPABILITIES;

  constructor(
    readonly id: string,
    private readonly config: AgentSessionConfig,
  ) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(): Promise<{ turnId: string }> {
    return { turnId: "turn-1" };
  }

  subscribe(): () => void {
    return () => {};
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.config.model ?? null,
      modeId: this.config.modeId ?? null,
    };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence(): AgentPersistenceHandle {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

class ChatWorkspaceFixtureTestClient implements AgentClient {
  readonly provider = "codex";
  readonly capabilities = CREATE_AGENT_TEST_CAPABILITIES;

  constructor(private readonly sessionId: string) {}

  async createSession(
    config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
    _options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    return new ChatWorkspaceFixtureTestSession(this.sessionId, config);
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    return new ChatWorkspaceFixtureTestSession(this.sessionId, {
      provider: this.provider,
      cwd: overrides?.cwd ?? process.cwd(),
    });
  }

  async fetchCatalog() {
    return {
      models: [{ provider: this.provider, id: "gpt-test", label: "GPT Test", isDefault: true }],
      modes: [],
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

export interface ChatWorkspaceTestFixture {
  workdir: string;
  paseoHome: string;
  emitted: SessionOutboundMessage[];
  session: Session;
  agentManager: AgentManager;
  workspaceRegistry: FileBackedWorkspaceRegistry;
  projectRegistry: FileBackedProjectRegistry;
}

// Shared builder for the two session.chat-workspace*.test.ts suites: both need a full
// Session wired to a scratch-backed AgentManager/WorkspaceRegistry/ProjectRegistry, just
// under different tmp dirs and fake agent identities so parallel test runs never collide.
export function createChatWorkspaceTestFixture(options: {
  workdirPrefix: string;
  clientId: string;
  sessionId: string;
  agentId: string;
}): ChatWorkspaceTestFixture {
  const workdir = mkdtempSync(path.join(tmpdir(), options.workdirPrefix));
  const paseoHome = path.join(workdir, "paseo-home");
  const logger = createTestLogger();
  const agentStorage = new AgentStorage(path.join(workdir, "agents"), logger);
  const agentManager = new AgentManager({
    clients: { codex: new ChatWorkspaceFixtureTestClient(options.sessionId) },
    registry: agentStorage,
    logger,
    idFactory: () => options.agentId,
  });
  const projectRegistry = new FileBackedProjectRegistry(
    path.join(workdir, "projects.json"),
    logger,
  );
  const workspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(workdir, "workspaces.json"),
    logger,
  );
  const workspaceGitService = createNoopWorkspaceGitService();
  const providerSnapshotManager = createProviderSnapshotManagerStub().manager;
  const workspaceAutoName = new WorkspaceAutoName({
    agentManager,
    workspaceRegistry,
    workspaceGitService,
    providerSnapshotManager,
    readDaemonConfig: () => ({ metadataGeneration: { providers: [] } }),
    gitMutation: { notifyGitMutation: async () => {} },
    emitWorkspaceUpdateForCwd: async () => {},
    emitWorkspaceUpdateForWorkspaceId: async () => {},
    logger,
  });
  const emitted: SessionOutboundMessage[] = [];
  const session = new Session({
    clientId: options.clientId,
    scopes: ["*"],
    appVersion: null,
    onMessage: (message) => emitted.push(message),
    logger,
    downloadTokenStore: asDownloadTokenStore(),
    pushTokenStore: asPushTokenStore(),
    paseoHome,
    agentManager,
    agentStorage,
    projectRegistry,
    workspaceRegistry,
    chatService: asChatService(),
    scheduleService: asScheduleService(),
    loopService: asLoopService(),
    checkoutDiffManager: asCheckoutDiffManager({
      subscribe: async () => ({
        initial: { cwd: paseoHome, files: [], error: null },
        unsubscribe: () => {},
      }),
      scheduleRefreshForCwd: () => {},
      onWorkspaceStateMayHaveChanged: () => {},
      getMetrics: () => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      }),
      dispose: () => {},
    }),
    workspaceGitService,
    workspaceAutoName,
    daemonConfigStore: asDaemonConfigStore({
      get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
      onChange: () => () => {},
    }),
    mcpBaseUrl: null,
    stt: null,
    tts: null,
    terminalManager: null,
    providerSnapshotManager,
    providerUsageService: new ProviderUsageService({ logger, fetchers: [] }),
  });

  return {
    workdir,
    paseoHome,
    emitted,
    session,
    agentManager,
    workspaceRegistry,
    projectRegistry,
  };
}

export async function disposeChatWorkspaceTestFixture(
  fixture: ChatWorkspaceTestFixture,
): Promise<void> {
  await fixture.session.cleanup();
  rmSync(fixture.workdir, { recursive: true, force: true });
}
