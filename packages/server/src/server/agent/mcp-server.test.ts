import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { realpathSync, rmSync } from "node:fs";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { createAgentMcpServer } from "./mcp-server.js";
import { AgentManager, type ManagedAgent } from "./agent-manager.js";
import { AgentStorage, type StoredAgentRecord } from "./agent-storage.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import type { AgentMode, AgentProvider, ProviderSnapshotEntry } from "./agent-sdk-types.js";
import type { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import {
  AgentListItemPayloadSchema,
  AgentPermissionRequestPayloadSchema,
  AgentSnapshotPayloadSchema,
} from "@getpaseo/protocol/messages";
import {
  createPersistedWorkspaceRecord,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
} from "../workspace-registry.js";
import type {
  CreateScheduleInput,
  StoredSchedule,
  UpdateScheduleInput,
} from "@getpaseo/protocol/schedule/types";
import type { ScheduleService } from "../schedule/service.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import {
  createPaseoWorktree as createPaseoWorktreeService,
  type CreatePaseoWorktreeInput,
} from "../paseo-worktree-service.js";
import {
  createPaseoWorktreeWorkflow,
  type CreatePaseoWorktreeWorkflowFn,
} from "../worktree-session.js";
import { WorkspaceGitServiceImpl } from "../workspace-git-service.js";
import { WorkspaceAutoName } from "../workspace-auto-name.js";
import { createGitMutationService } from "../session/git-mutation/git-mutation-service.js";
import type { GeneratedWorkspaceName } from "../worktree-branch-name-generator.js";
import type { GitHubService } from "../../services/github-service.js";
import type { TerminalManager } from "../../terminal/terminal-manager.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { BrowserToolsBroker, BrowserToolsExecuteInput } from "../browser-tools/broker.js";
import type { BrowserToolsResponsePayload } from "../browser-tools/errors.js";
import { readPaseoWorktreeMetadata } from "../../utils/worktree-metadata.js";

const REPO_CWD = resolvePath("/tmp/repo");
const TARGET_CWD = resolvePath("/tmp/target");
const BROWSER_WORKSPACE_ID = "wks_browser_tools";

interface LooseSafeParseResult {
  success: boolean;
  data: unknown;
  error: {
    issues: Array<{ path: Array<string | number>; message: string; code: string }>;
  };
}

interface LooseInputSchema {
  safeParseAsync(input: unknown): Promise<LooseSafeParseResult>;
}

interface LooseStructuredContent {
  [key: string]: unknown;
}

interface LooseContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface RegisteredMcpTool {
  inputSchema: LooseInputSchema;
  callback?: (
    input: unknown,
    extra?: unknown,
  ) => Promise<{
    structuredContent: LooseStructuredContent;
    content?: LooseContentBlock[];
  }>;
  handler?: (input: unknown) => Promise<{
    structuredContent: LooseStructuredContent;
    content?: LooseContentBlock[];
  }>;
}

interface RegisteredMcpToolWithHandler extends RegisteredMcpTool {
  handler: (input: unknown) => Promise<{
    structuredContent: LooseStructuredContent;
    content?: LooseContentBlock[];
  }>;
}

function lookupTool(
  server: Awaited<ReturnType<typeof createAgentMcpServer>>,
  name: string,
): RegisteredMcpTool | undefined {
  const tools: Record<string, RegisteredMcpTool> = Reflect.get(server, "_registeredTools");
  return tools[name];
}

function registeredTool(
  server: Awaited<ReturnType<typeof createAgentMcpServer>>,
  name: string,
): RegisteredMcpToolWithHandler {
  const tool = lookupTool(server, name);
  if (!tool) {
    throw new Error(`MCP tool not registered: ${name}`);
  }
  const handler = tool.handler ?? tool.callback;
  if (!handler) {
    throw new Error(`MCP tool has no callable handler: ${name}`);
  }
  return { ...tool, handler };
}

async function invokeToolWithParsedInput(
  tool: RegisteredMcpToolWithHandler,
  input: Record<string, unknown>,
) {
  const parsed = await tool.inputSchema.safeParseAsync(input);
  expect(parsed.success).toBe(true);
  return tool.handler(parsed.data);
}

function agentsOf(response: {
  structuredContent: LooseStructuredContent;
}): Array<Record<string, unknown>> {
  return z.array(z.record(z.string(), z.unknown())).parse(response.structuredContent.agents);
}

function expectSingleTextContent(response: { content?: LooseContentBlock[] }): string {
  const content = response.content ?? [];
  expect(content).toHaveLength(1);
  const block = content[0];
  expect(block?.type).toBe("text");
  return z.string().min(1).parse(block?.text);
}

async function waitForWorkspaceTitle(
  workspaceRecords: Map<string, PersistedWorkspaceRecord>,
  workspaceId: string,
  title: string,
): Promise<void> {
  await vi.waitFor(() => expect(workspaceRecords.get(workspaceId)?.title).toBe(title), {
    timeout: 5_000,
  });
}

async function waitForWorkspaceBranch(
  workspaceRecords: Map<string, PersistedWorkspaceRecord>,
  workspaceId: string,
  branch: string,
): Promise<void> {
  await vi.waitFor(() => expect(workspaceRecords.get(workspaceId)?.branch).toBe(branch), {
    timeout: 5_000,
  });
}

async function waitForUnexpectedWorkspaceNamingSideEffects(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function removeTempDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

type AgentManagerSpies = ReturnType<typeof buildAgentManagerSpies>;
type AgentStorageSpies = ReturnType<typeof buildAgentStorageSpies>;

interface TestDeps {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  spies: {
    agentManager: AgentManagerSpies;
    agentStorage: AgentStorageSpies;
  };
}

function buildAgentManagerSpies() {
  return {
    createAgent: vi.fn(),
    waitForAgentEvent: vi.fn().mockResolvedValue({
      status: "idle",
      permission: null,
      lastMessage: null,
    }),
    setAgentMode: vi.fn().mockResolvedValue(undefined),
    setAgentModel: vi.fn().mockResolvedValue(undefined),
    setAgentThinkingOption: vi.fn().mockResolvedValue(undefined),
    setAgentFeature: vi.fn().mockResolvedValue(undefined),
    setLabels: vi.fn().mockResolvedValue(undefined),
    setTitle: vi.fn().mockResolvedValue(undefined),
    updateAgentMetadata: vi.fn().mockResolvedValue(undefined),
    archiveAgent: vi.fn().mockResolvedValue({ archivedAt: new Date().toISOString() }),
    notifyAgentState: vi.fn(),
    getAgent: vi.fn(),
    listAgents: vi.fn().mockReturnValue([]),
    getTimeline: vi.fn().mockReturnValue([]),
    resumeAgentFromPersistence: vi.fn(),
    hydrateTimelineFromProvider: vi.fn().mockResolvedValue(undefined),
    appendTimelineItem: vi.fn().mockResolvedValue(undefined),
    emitLiveTimelineItem: vi.fn().mockResolvedValue(undefined),
    hasInFlightRun: vi.fn().mockReturnValue(false),
    tryRunOutOfBand: vi.fn().mockReturnValue(false),
    subscribe: vi.fn().mockReturnValue(() => {}),
    streamAgent: vi.fn(() => (async function* noop() {})()),
    waitForAgentRunStart: vi.fn().mockResolvedValue(undefined),
    respondToPermission: vi.fn(),
    cancelAgentRun: vi.fn(),
    getPendingPermissions: vi.fn(),
    getRegisteredProviderIds: vi.fn().mockReturnValue(["claude"]),
    listDraftFeatures: vi.fn(),
  };
}

function buildAgentStorageSpies() {
  return {
    get: vi.fn().mockResolvedValue(null),
    setTitle: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    applySnapshot: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    remove: vi.fn(),
  };
}

function createTestDeps(): TestDeps {
  const agentManagerSpies = buildAgentManagerSpies();
  const agentStorageSpies = buildAgentStorageSpies();

  return {
    agentManager: agentManagerSpies as unknown as AgentManager,
    agentStorage: agentStorageSpies as unknown as AgentStorage,
    spies: {
      agentManager: agentManagerSpies,
      agentStorage: agentStorageSpies,
    },
  };
}

function createTerminalManagerStub(overrides: Partial<TerminalManager> = {}): TerminalManager {
  return {
    getTerminals: vi.fn().mockResolvedValue([]),
    createTerminal: vi.fn(),
    registerCwdEnv: vi.fn(),
    getTerminal: vi.fn(),
    getTerminalState: vi.fn().mockResolvedValue(null),
    killTerminal: vi.fn(),
    killTerminalAndWait: vi.fn().mockResolvedValue(undefined),
    captureTerminal: vi.fn().mockResolvedValue({ lines: [], totalLines: 0 }),
    listDirectories: vi.fn().mockReturnValue([]),
    killAll: vi.fn(),
    subscribeTerminalsChanged: vi.fn().mockReturnValue(() => {}),
    subscribeTerminalWorkspaceContributionChanged: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  } as unknown as TerminalManager;
}

type ProviderSnapshotManagerStub = ReturnType<typeof createProviderSnapshotManagerStub>;

interface ConfigureProviderEntry {
  provider: AgentProvider;
  label?: string;
  description?: string;
  enabled?: boolean;
  defaultModeId?: string;
  modes?: AgentMode[];
}

// Builds a ProviderSnapshotEntry for tests that need to configure listProviders /
// getProvider directly. Mirrors the shape MCP server reads from the manager:
// status: "ready" for enabled+available, "unavailable" for disabled.
function buildSnapshotEntry(entry: ConfigureProviderEntry): ProviderSnapshotEntry {
  const enabled = entry.enabled ?? true;
  if (!enabled) {
    return {
      provider: entry.provider,
      status: "unavailable",
      enabled: false,
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      ...(entry.defaultModeId !== undefined ? { defaultModeId: entry.defaultModeId } : {}),
      modes: [],
    };
  }
  return {
    provider: entry.provider,
    status: "ready",
    enabled: true,
    ...(entry.label !== undefined ? { label: entry.label } : {}),
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    ...(entry.defaultModeId !== undefined ? { defaultModeId: entry.defaultModeId } : {}),
    modes: entry.modes ?? [],
  };
}

// Shared helper used by ~60 create_agent / update_agent / list_agents tests that
// only need a "normal" provider catalog (claude, codex, opencode). OpenCode
// create-config behavior delegates to the production provider client.
//
// NOTE: This is NOT a registry. It directly configures the public stub surface.
// Per-test customization is done by overriding individual stub methods after
// calling this helper.
interface ConfigureOpenCodeProviderStubOptions {
  customOpenCodeProvider?: AgentProvider;
}

function configureOpenCodeProviderStub(
  stub: ProviderSnapshotManagerStub,
  options: ConfigureOpenCodeProviderStubOptions = {},
): void {
  const claudeModes: AgentMode[] = [
    { id: "default", label: "Default", description: "Ask first" },
    { id: "bypassPermissions", label: "Bypass", description: "No prompts", isUnattended: true },
  ];
  const codexModes: AgentMode[] = [
    { id: "default", label: "Default", description: "Default" },
    { id: "auto", label: "Auto", description: "Auto" },
    { id: "full-access", label: "Full Access", description: "No prompts", isUnattended: true },
  ];
  const opencodeModes: AgentMode[] = [
    { id: "build", label: "Build", description: "Can edit" },
    { id: "plan", label: "Plan", description: "Read-only" },
    { id: "paseo-custom", label: "Paseo Custom", description: "Custom OpenCode agent" },
  ];
  const entries: ProviderSnapshotEntry[] = [
    buildSnapshotEntry({
      provider: "claude",
      label: "Claude",
      description: "Anthropic Claude",
      defaultModeId: "default",
      modes: claudeModes,
    }),
    buildSnapshotEntry({
      provider: "codex",
      label: "Codex",
      description: "OpenAI Codex",
      defaultModeId: "default",
      modes: codexModes,
    }),
    buildSnapshotEntry({
      provider: "opencode",
      label: "OpenCode",
      description: "OpenCode agent",
      defaultModeId: "build",
      modes: opencodeModes,
    }),
  ];
  const customOpenCodeModes: AgentMode[] = [
    ...opencodeModes,
    { id: "paseo-custom", label: "Paseo Custom" },
  ];
  if (options.customOpenCodeProvider) {
    entries.push(
      buildSnapshotEntry({
        provider: options.customOpenCodeProvider,
        label: "OpenCode Custom",
        description: "Custom OpenCode agent",
        defaultModeId: "build",
        modes: customOpenCodeModes,
      }),
    );
  }
  const modesByProvider: Record<string, AgentMode[]> = {
    claude: claudeModes,
    codex: codexModes,
    opencode: opencodeModes,
  };
  if (options.customOpenCodeProvider) {
    modesByProvider[options.customOpenCodeProvider] = customOpenCodeModes;
  }

  stub.listRegisteredProviderIds.mockReturnValue(entries.map((entry) => entry.provider));
  stub.hasProvider.mockImplementation((provider) =>
    Object.prototype.hasOwnProperty.call(modesByProvider, provider),
  );
  stub.getProviderLabel.mockImplementation((provider) => {
    const entry = entries.find((e) => e.provider === provider);
    return entry?.label ?? provider;
  });
  stub.listProviders.mockImplementation(async (input) => {
    const opts = (input ?? {}) as { providers?: AgentProvider[] };
    if (!opts.providers) return entries;
    const filter = new Set(opts.providers);
    return entries.filter((e) => filter.has(e.provider));
  });
  stub.getProvider.mockImplementation(async (input) => {
    const opts = input as { provider: AgentProvider };
    const entry = entries.find((e) => e.provider === opts.provider);
    if (!entry) throw new Error(`Provider ${opts.provider} is not configured`);
    return entry;
  });
  stub.listModels.mockResolvedValue([]);
  stub.listModes.mockImplementation(async (input) => {
    const opts = input as { provider: AgentProvider };
    return modesByProvider[opts.provider] ?? [];
  });
  stub.resolveCreateConfig.mockImplementation(async (input) => {
    const opts = input as {
      provider: AgentProvider;
      requestedMode: string | undefined;
      featureValues: Record<string, unknown> | undefined;
    };
    return { modeId: opts.requestedMode, featureValues: opts.featureValues };
  });
}

// Quick helper: returns a manager configured with the standard OpenCode catalog.
function createOpenCodeManager(options?: ConfigureOpenCodeProviderStubOptions): {
  manager: ProviderSnapshotManagerStub["manager"];
  stub: ProviderSnapshotManagerStub;
} {
  const stub = createProviderSnapshotManagerStub();
  configureOpenCodeProviderStub(stub, options);
  return { manager: stub.manager, stub };
}

// Quick helper: returns a bare stub manager seam. Use when the test does not
// care about provider behavior at all (terminal tests, schema-only tests,
// stored-agent listing tests where the stored agent's provider just needs to
// be in listRegisteredProviderIds).
function createClaudeOnlyManager(): ProviderSnapshotManagerStub["manager"] {
  const stub = createProviderSnapshotManagerStub();
  stub.listRegisteredProviderIds.mockReturnValue(["claude"]);
  stub.hasProvider.mockImplementation((provider) => provider === "claude");
  return stub.manager;
}

function createStoredRecord(overrides: Partial<StoredAgentRecord> = {}): StoredAgentRecord {
  const now = "2026-04-11T00:00:00.000Z";
  return {
    id: "stored-agent",
    provider: "claude",
    cwd: "/tmp/stored-project",
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    lastUserMessageAt: null,
    title: "Stored agent",
    labels: {},
    lastStatus: "closed",
    lastModeId: "default",
    config: {
      modeId: "default",
      model: "claude-sonnet-4-20250514",
    },
    runtimeInfo: {
      provider: "claude",
      sessionId: "session-123",
      model: "claude-sonnet-4-20250514",
    },
    features: [],
    persistence: {
      provider: "claude",
      sessionId: "session-123",
    },
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    internal: false,
    archivedAt: "2026-04-12T00:00:00.000Z",
    ...overrides,
  };
}

function createManagedAgent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  const now = new Date();
  return {
    id: "live-agent",
    provider: "claude",
    cwd: "/tmp/live-project",
    config: {},
    runtimeInfo: undefined,
    createdAt: now,
    updatedAt: now,
    lastUserMessageAt: null,
    lifecycle: "idle",
    capabilities: {
      supportsStreaming: false,
      supportsSessionPersistence: false,
      supportsDynamicModes: false,
      supportsMcpServers: true,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    features: [],
    pendingPermissions: new Map(),
    persistence: null,
    labels: {},
    attention: { requiresAttention: false },
    ...overrides,
  } as ManagedAgent;
}

function createGitHubServiceStub(): GitHubService {
  return {
    listPullRequests: async () => [],
    listIssues: async () => [],
    searchIssuesAndPrs: async () => ({ items: [], githubFeaturesEnabled: true }),
    getPullRequest: async ({ number }) => ({
      number,
      title: `PR ${number}`,
      url: `https://github.com/acme/repo/pull/${number}`,
      state: "OPEN",
      body: null,
      baseRefName: "main",
      headRefName: `pr-${number}`,
      labels: [],
    }),
    getPullRequestHeadRef: async ({ number }) => `pr-${number}`,
    getCurrentPullRequestStatus: async () => null,
    createPullRequest: async () => ({
      number: 1,
      url: "https://github.com/acme/repo/pull/1",
    }),
    mergePullRequest: async () => ({ success: true }),
    isAuthenticated: async () => true,
    invalidate: () => {},
  };
}

class FakeBrowserToolsBroker {
  public readonly calls: BrowserToolsExecuteInput[] = [];

  public constructor(private readonly response: BrowserToolsResponsePayload) {}

  public async execute(input: BrowserToolsExecuteInput): Promise<BrowserToolsResponsePayload> {
    this.calls.push(input);
    return this.response;
  }
}

class BoundaryAgentManagerFake {
  private readonly agent = createManagedAgent({
    id: "agent-1",
    cwd: REPO_CWD,
    workspaceId: BROWSER_WORKSPACE_ID,
  });

  public getAgent(agentId: string): ManagedAgent | null {
    return agentId === this.agent.id ? this.agent : null;
  }

  public listAgents(): ManagedAgent[] {
    return [];
  }
}

class BoundaryAgentStorageFake {
  public async list(): Promise<StoredAgentRecord[]> {
    return [];
  }
}

class BoundaryProviderSnapshotManagerFake {
  public listRegisteredProviderIds(): AgentProvider[] {
    return [];
  }

  public hasProvider(): boolean {
    return false;
  }

  public getProviderLabel(provider: AgentProvider): string {
    return provider;
  }

  public async listProviders(): Promise<ProviderSnapshotEntry[]> {
    return [];
  }

  public async getProvider(): Promise<ProviderSnapshotEntry> {
    throw new Error("Provider catalog is not used by this boundary test");
  }

  public async listModels(): Promise<[]> {
    return [];
  }

  public async listModes(): Promise<[]> {
    return [];
  }
}

async function connectInMemoryMcpClient(server: Awaited<ReturnType<typeof createAgentMcpServer>>) {
  const client = new Client({ name: "paseo-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function createStoredSchedule(input: CreateScheduleInput): StoredSchedule {
  const now = "2026-04-11T00:00:00.000Z";
  return {
    id: "schedule-1",
    name: input.name ?? null,
    prompt: input.prompt,
    cadence: input.cadence,
    target: input.target,
    status: "active",
    createdAt: now,
    updatedAt: now,
    nextRunAt: now,
    lastRunAt: null,
    pausedAt: null,
    expiresAt: input.expiresAt ?? null,
    maxRuns: input.maxRuns ?? null,
    runs: [],
  };
}

function createArchiveWorkspaceRecordMutator(
  activeWorkspaces: Array<{
    workspaceId: string;
    cwd: string;
    kind: "worktree" | "local_checkout" | "directory";
  }>,
  archivedWorkspaceIds: string[],
) {
  return async (workspaceId: string) => {
    archivedWorkspaceIds.push(workspaceId);
    const index = activeWorkspaces.findIndex((workspace) => workspace.workspaceId === workspaceId);
    if (index !== -1) {
      activeWorkspaces.splice(index, 1);
    }
  };
}

function createPaseoWorktreeForMcpTest(options: {
  paseoHome: string;
  broadcasts: string[];
  createdWorkspaceIds?: string[];
  workspaceRecords?: Map<string, PersistedWorkspaceRecord>;
  generateWorkspaceName?: () => Promise<GeneratedWorkspaceName | null>;
  setupContinuations?: Array<"workspace" | "agent" | undefined>;
  startedAgentSetupIds?: string[];
}): CreatePaseoWorktreeWorkflowFn {
  const projects = new Map<string, PersistedProjectRecord>();
  const workspaces = options.workspaceRecords ?? new Map<string, PersistedWorkspaceRecord>();
  const github = createGitHubServiceStub();
  const workspaceGitService = new WorkspaceGitServiceImpl({
    logger: createTestLogger(),
    paseoHome: options.paseoHome,
    deps: { github },
  });
  const workspaceRegistry = {
    get: async (workspaceId: string) => workspaces.get(workspaceId) ?? null,
    list: async () => Array.from(workspaces.values()),
    upsert: async (record: PersistedWorkspaceRecord) => {
      workspaces.set(record.workspaceId, record);
    },
  };
  const workspaceAutoName = new WorkspaceAutoName({
    agentManager: buildAgentManagerSpies() as unknown as AgentManager,
    workspaceRegistry,
    workspaceGitService,
    providerSnapshotManager: createOpenCodeManager().manager,
    readDaemonConfig: () => ({ metadataGeneration: { providers: [] } }),
    gitMutation: createGitMutationService({
      workspaceGitService,
      github,
      logger: createTestLogger(),
    }),
    emitWorkspaceUpdateForCwd: async (cwd) => {
      const workspace = Array.from(workspaces.values()).find((record) => record.cwd === cwd);
      options.broadcasts.push(z.string().parse(workspace?.workspaceId));
    },
    emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
      options.broadcasts.push(workspaceId);
    },
    logger: createTestLogger(),
    generateWorkspaceName: options.generateWorkspaceName ?? (async () => null),
  });

  return async (input, serviceOptions) => {
    options.setupContinuations?.push(serviceOptions?.setupContinuation?.kind);
    const result = await createPaseoWorktreeWorkflow(
      {
        paseoHome: options.paseoHome,
        createPaseoWorktree: (workflowInput, workflowOptions) =>
          createPaseoWorktreeService(workflowInput, {
            github,
            ...(workflowOptions?.resolveDefaultBranch
              ? { resolveDefaultBranch: workflowOptions.resolveDefaultBranch }
              : {}),
            projectRegistry: {
              get: async (projectId) => projects.get(projectId) ?? null,
              upsert: async (record) => {
                projects.set(record.projectId, record);
              },
            },
            workspaceRegistry,
            workspaceGitService,
          }),
        warmWorkspaceGitData: async () => {},
        autoNameWorkspaceBranchForFirstAgent: (autoNameInput) =>
          workspaceAutoName.scheduleForWorktree(autoNameInput),
        emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
          options.broadcasts.push(workspaceId);
        },
        cacheWorkspaceSetupSnapshot: () => {},
        emit: () => {},
        sessionLogger: createTestLogger(),
        terminalManager: null,
        archiveWorkspaceRecord: async () => {},
        serviceProxy: null,
        scriptRuntimeStore: null,
        getDaemonTcpPort: null,
        getDaemonTcpHost: null,
        onScriptsChanged: null,
      },
      input,
      serviceOptions,
    );
    options.broadcasts.push(result.workspace.workspaceId);
    options.createdWorkspaceIds?.push(result.workspace.workspaceId);
    if (serviceOptions?.setupContinuation?.kind === "agent") {
      return {
        ...result,
        setupContinuation: {
          kind: "agent",
          startAfterAgentCreate: ({ agentId }) => {
            options.startedAgentSetupIds?.push(agentId);
          },
        },
      };
    }
    return result;
  };
}

describe("browser MCP tools", () => {
  const logger = createTestLogger();

  it("omits output schemas from tools/list and keeps tool call content model-visible", async () => {
    const agentManager = new BoundaryAgentManagerFake();
    const agentStorage = new BoundaryAgentStorageFake();
    const broker = new FakeBrowserToolsBroker({
      requestId: "req-browser-tabs",
      ok: true,
      result: { command: "list_tabs", tabs: [] },
    });
    const serverOptions = {
      agentManager: agentManager as AgentManager,
      agentStorage: agentStorage as AgentStorage,
      providerSnapshotManager:
        new BoundaryProviderSnapshotManagerFake() as unknown as ProviderSnapshotManager,
      browserToolsEnabled: true,
      browserToolsBroker: broker as BrowserToolsBroker,
      callerAgentId: "agent-1",
      logger,
    };
    const server = await createAgentMcpServer(serverOptions);
    const client = await connectInMemoryMcpClient(server);

    try {
      const browserResult = await client.callTool({
        name: "browser_list_tabs",
        arguments: {},
      });
      const listAgentsResult = await client.callTool({
        name: "list_agents",
        arguments: {},
      });

      expect(broker.calls).toEqual([
        {
          agentId: "agent-1",
          cwd: REPO_CWD,
          workspaceId: BROWSER_WORKSPACE_ID,
          command: { command: "list_tabs", args: {} },
        },
      ]);
      expect(browserResult.isError).not.toBe(true);
      expect(browserResult.structuredContent).toEqual({
        ok: true,
        result: { command: "list_tabs", tabs: [] },
        context: { agentId: "agent-1", cwd: REPO_CWD, workspaceId: BROWSER_WORKSPACE_ID },
      });
      expect(listAgentsResult.isError).not.toBe(true);
      expect(listAgentsResult.structuredContent).toEqual({
        agents: [],
      });
      expectSingleTextContent(browserResult);
      expect(expectSingleTextContent(listAgentsResult)).toContain('"agents": []');

      const listedTools = await client.listTools();
      expect(listedTools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["browser_list_tabs", "list_agents"]),
      );
      for (const tool of listedTools.tools) {
        expect(tool, `${tool.name} outputSchema`).not.toHaveProperty("outputSchema");
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns screenshot pixels as image content and keeps structured content metadata-only", async () => {
    const agentManager = new BoundaryAgentManagerFake();
    const agentStorage = new BoundaryAgentStorageFake();
    const broker = new FakeBrowserToolsBroker({
      requestId: "req-browser-screenshot",
      ok: true,
      result: {
        command: "screenshot",
        browserId: "11111111-1111-4111-8111-111111111111",
        mimeType: "image/png",
        dataBase64: "iVBORw0KGgo=",
        width: 800,
        height: 600,
      },
    });
    const server = await createAgentMcpServer({
      agentManager: agentManager as AgentManager,
      agentStorage: agentStorage as AgentStorage,
      providerSnapshotManager:
        new BoundaryProviderSnapshotManagerFake() as unknown as ProviderSnapshotManager,
      browserToolsEnabled: true,
      browserToolsBroker: broker as BrowserToolsBroker,
      callerAgentId: "agent-1",
      logger,
    });
    const client = await connectInMemoryMcpClient(server);

    try {
      const response = await client.callTool({
        name: "browser_screenshot",
        arguments: { browserId: "11111111-1111-4111-8111-111111111111" },
      });

      expect(broker.calls).toEqual([
        {
          agentId: "agent-1",
          cwd: REPO_CWD,
          workspaceId: BROWSER_WORKSPACE_ID,
          command: {
            command: "screenshot",
            args: {
              browserId: "11111111-1111-4111-8111-111111111111",
              fullPage: false,
            },
          },
        },
      ]);
      expect(response.content).toEqual([
        { type: "text", text: "Captured browser screenshot (800x600)." },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ]);
      expect(response.structuredContent).toEqual({
        ok: true,
        result: {
          command: "screenshot",
          browserId: "11111111-1111-4111-8111-111111111111",
          mimeType: "image/png",
          width: 800,
          height: 600,
        },
        context: {
          agentId: "agent-1",
          cwd: REPO_CWD,
          workspaceId: BROWSER_WORKSPACE_ID,
          browserId: "11111111-1111-4111-8111-111111111111",
        },
      });
      expect(JSON.stringify(response.structuredContent)).not.toContain("iVBORw0KGgo=");
      expect(JSON.stringify(response.structuredContent)).not.toContain("dataBase64");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not register browser tools when browser tools are disabled", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "agent-1",
      cwd: REPO_CWD,
      workspaceId: BROWSER_WORKSPACE_ID,
    });
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      browserToolsEnabled: false,
      callerAgentId: "agent-1",
      logger,
    });

    expect(lookupTool(server, "browser_list_tabs")).toBeUndefined();
    expect(lookupTool(server, "browser_snapshot")).toBeUndefined();
  });

  it("wires browser tools through the browser tools broker", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "agent-1",
      cwd: REPO_CWD,
      workspaceId: BROWSER_WORKSPACE_ID,
    });
    const execute = vi.fn().mockResolvedValue({
      requestId: "req-browser-tabs",
      ok: true,
      result: { command: "list_tabs", tabs: [] },
    });
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      browserToolsEnabled: true,
      browserToolsBroker: { execute } as never,
      callerAgentId: "agent-1",
      logger,
    });
    const tool = registeredTool(server, "browser_list_tabs");

    const response = await tool.handler({});

    expect(execute).toHaveBeenCalledWith({
      agentId: "agent-1",
      cwd: REPO_CWD,
      workspaceId: BROWSER_WORKSPACE_ID,
      command: { command: "list_tabs", args: {} },
    });
    expect(response.content).toEqual([
      {
        type: "text",
        text: "No Paseo browser tabs are open. Call browser_new_tab to create one.",
      },
    ]);
    expect(response.structuredContent).toEqual({
      ok: true,
      result: { command: "list_tabs", tabs: [] },
      context: { agentId: "agent-1", cwd: REPO_CWD, workspaceId: BROWSER_WORKSPACE_ID },
    });
  });

  it("tells browser callers without a workspace how to proceed before broker execution", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({ id: "agent-1", cwd: REPO_CWD });
    const execute = vi.fn().mockResolvedValue({
      requestId: "req-browser-tabs",
      ok: true,
      result: { command: "list_tabs", tabs: [] },
    });
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      browserToolsEnabled: true,
      browserToolsBroker: { execute } as never,
      callerAgentId: "agent-1",
      logger,
    });
    const tool = registeredTool(server, "browser_list_tabs");

    const response = await tool.handler({});

    expect(execute).not.toHaveBeenCalled();
    expect(response.content).toEqual([
      {
        type: "text",
        text: "This browser tool needs a workspace. Start the agent from a Paseo workspace before calling browser_new_tab or browser_list_tabs.",
      },
    ]);
    expect(response.structuredContent).toEqual({
      ok: false,
      error: {
        code: "browser_denied",
        message:
          "This browser tool needs a workspace. Start the agent from a Paseo workspace before calling browser_new_tab or browser_list_tabs.",
        retryable: false,
      },
      context: { agentId: "agent-1", cwd: REPO_CWD },
    });
  });
});

describe("terminal MCP tools", () => {
  const logger = createTestLogger();

  it("captures terminal output through the terminal manager authority", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const captureTerminal = vi.fn().mockResolvedValue({
      lines: ["from worker scrollback"],
      totalLines: 42,
    });
    const terminalManager = createTerminalManagerStub({
      getTerminal: vi.fn().mockReturnValue({
        id: "term-1",
        name: "daemon",
        cwd: process.cwd(),
        getState: vi.fn().mockReturnValue({ scrollback: [], grid: [[]] }),
      }),
      captureTerminal,
    });
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      terminalManager,
      logger,
    });
    const tool = registeredTool(server, "capture_terminal");

    const response = await tool.handler({
      terminalId: "term-1",
      scrollback: true,
      stripAnsi: false,
      start: -10,
      end: -1,
    });

    expect(captureTerminal).toHaveBeenCalledWith("term-1", {
      start: 0,
      end: -1,
      stripAnsi: false,
    });
    expect(response.structuredContent).toEqual({
      terminalId: "term-1",
      lines: ["from worker scrollback"],
      totalLines: 42,
    });
  });
});

describe("create_agent MCP tool", () => {
  const logger = createTestLogger();
  const existingCwd = process.cwd();
  const detachedDirectoryWorkspace = (path = existingCwd) => ({
    relationship: { kind: "detached" as const },
    workspace: { kind: "create" as const, source: { kind: "directory" as const, path } },
  });
  const detachedWorktreeWorkspace = (
    cwd: string,
    target:
      | { kind: "branch-off"; worktreeSlug?: string; branchName?: string; baseBranch?: string }
      | { kind: "checkout-branch"; branch: string }
      | { kind: "checkout-pr"; githubPrNumber: number },
  ) => ({
    relationship: { kind: "detached" as const },
    workspace: { kind: "create" as const, source: { kind: "worktree" as const, cwd, target } },
  });
  const subagentCurrentWorkspace = (cwd?: string) => ({
    relationship: { kind: "subagent" as const },
    workspace: { kind: "current" as const, ...(cwd ? { cwd } : {}) },
  });
  const detachedCurrentWorkspace = (cwd?: string) => ({
    relationship: { kind: "detached" as const },
    workspace: { kind: "current" as const, ...(cwd ? { cwd } : {}) },
  });
  const detachedExistingWorkspace = (workspaceId: string, cwd?: string) => ({
    relationship: { kind: "detached" as const },
    workspace: { kind: "existing" as const, workspaceId, ...(cwd ? { cwd } : {}) },
  });
  const ensureWorkspaceForCreate = async () => "workspace-created";

  it("requires a concise title no longer than 60 characters", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    expect(tool).toBeDefined();

    const missingTitle = await tool.inputSchema.safeParseAsync({
      ...detachedDirectoryWorkspace(existingCwd),
      settings: { modeId: "default" },
      provider: "codex/gpt-5.4",
      initialPrompt: "test",
    });
    expect(missingTitle.success).toBe(false);
    expect(missingTitle.error.issues[0].path).toEqual(["title"]);

    const tooLong = await tool.inputSchema.safeParseAsync({
      ...detachedDirectoryWorkspace(existingCwd),
      settings: { modeId: "default" },
      provider: "codex/gpt-5.4",
      title: "x".repeat(61),
      initialPrompt: "test",
    });
    expect(tooLong.success).toBe(false);
    expect(tooLong.error.issues[0].path).toEqual(["title"]);

    const ok = await tool.inputSchema.safeParseAsync({
      ...detachedDirectoryWorkspace(existingCwd),
      settings: { modeId: "default" },
      provider: "codex/gpt-5.4",
      title: "Short title",
      initialPrompt: "test",
    });
    expect(ok.success).toBe(true);
  });

  it("requires initialPrompt", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    const parsed = await tool.inputSchema.safeParseAsync({
      ...detachedDirectoryWorkspace(existingCwd),
      settings: { modeId: "default" },
      provider: "codex/gpt-5.4",
      title: "Short title",
    });
    expect(parsed.success).toBe(false);
    expect(
      parsed.error.issues.some(
        (issue: { path: Array<string | number> }) => issue.path[0] === "initialPrompt",
      ),
    ).toBe(true);
  });

  it("rejects partial explicit workspace shape", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");

    const parsed = await tool.inputSchema.safeParseAsync({
      relationship: { kind: "detached" },
      title: "Short title",
      provider: "codex/gpt-5.4",
      initialPrompt: "test",
    });

    expect(parsed.success).toBe(true);
    await expect(tool.handler(parsed.data)).rejects.toThrow(
      "relationship and workspace must be provided together",
    );
  });

  it("rejects caller-only relationship and workspace intents without a caller agent", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });
    const tool = registeredTool(server, "create_agent");

    await expect(
      tool.handler({
        ...subagentCurrentWorkspace(),
        title: "Short title",
        provider: "codex/gpt-5.4",
        initialPrompt: "test",
      }),
    ).rejects.toThrow("relationship subagent requires an agent-scoped tool session");

    await expect(
      tool.handler({
        ...detachedCurrentWorkspace(),
        title: "Short title",
        provider: "codex/gpt-5.4",
        initialPrompt: "test",
      }),
    ).rejects.toThrow("workspace current requires an agent-scoped tool session");
  });

  it("requires a caller workspace for current workspace intent", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "parent-agent",
      cwd: existingCwd,
      provider: "codex",
      currentModeId: "full-access",
    } as ManagedAgent);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "parent-agent",
      logger,
    });
    const tool = registeredTool(server, "create_agent");

    await expect(
      tool.handler({
        ...subagentCurrentWorkspace(),
        title: "Child",
        provider: "codex/gpt-5.4",
        initialPrompt: "Do work",
      }),
    ).rejects.toThrow("Caller agent parent-agent has no current workspace");
  });

  it("attaches create_agent to an existing workspace id", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "existing-workspace-agent",
      cwd: existingCwd,
      workspaceId: "wks_existing",
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Existing workspace" },
    } as ManagedAgent);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      listActiveWorkspaces: async () => [
        { workspaceId: "wks_existing", cwd: existingCwd, kind: "worktree" },
      ],
      logger,
    });
    const tool = registeredTool(server, "create_agent");

    const response = await tool.handler({
      ...detachedExistingWorkspace("wks_existing"),
      title: "Existing workspace",
      provider: "codex/gpt-5.4",
      initialPrompt: "Do work",
      background: true,
    });

    expect(response.structuredContent.workspaceId).toBe("wks_existing");
    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: existingCwd,
      }),
      undefined,
      { workspaceId: "wks_existing" },
    );
  });

  it("accepts provider features and passes them through createAgent", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "feature-agent",
      cwd: REPO_CWD,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Feature test", featureValues: { fast_mode: true } },
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    const input = {
      ...detachedDirectoryWorkspace(existingCwd),
      title: "Feature test",
      provider: "codex/gpt-5.4",
      initialPrompt: "Do work",
      background: true,
      settings: { features: { fast_mode: true } },
    };

    const parsed = await tool.inputSchema.safeParseAsync(input);
    expect(parsed.success).toBe(true);

    await tool.handler(input);

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        model: "gpt-5.4",
        featureValues: { fast_mode: true },
      }),
      undefined,
      { workspaceId: "workspace-created" },
    );
  });

  it("returns create_agent structured content with full provider modes", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "mode-agent",
      provider: "codex",
      cwd: REPO_CWD,
      lifecycle: "idle",
      currentModeId: "build",
      availableModes: [
        {
          id: "build",
          label: "Build",
          description: null,
          icon: "hammer",
          colorTier: "dangerous",
        },
      ],
      config: { title: "Mode test" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    const response = await tool.handler({
      ...detachedDirectoryWorkspace(existingCwd),
      title: "Mode test",
      provider: "codex/gpt-5.4",
      initialPrompt: "Do work",
      background: true,
    });

    expect(response.structuredContent).toEqual(
      expect.objectContaining({
        agentId: "mode-agent",
        type: "codex",
        status: "idle",
        cwd: REPO_CWD,
        currentModeId: "build",
        availableModes: [
          {
            id: "build",
            label: "Build",
            description: null,
            icon: "hammer",
            colorTier: "dangerous",
          },
        ],
      }),
    );
  });

  it("requires provider as provider/model and rejects the old model field", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");

    const missingProvider = await tool.inputSchema.safeParseAsync({
      ...detachedDirectoryWorkspace(existingCwd),
      settings: { modeId: "default" },
      title: "Short title",
      initialPrompt: "test",
    });
    expect(missingProvider.success).toBe(false);
    expect(
      missingProvider.error.issues.some(
        (issue: { path: Array<string | number> }) => issue.path[0] === "provider",
      ),
    ).toBe(true);

    const providerWithoutModel = await tool.inputSchema.safeParseAsync({
      ...detachedDirectoryWorkspace(existingCwd),
      settings: { modeId: "default" },
      title: "Short title",
      provider: "codex",
      initialPrompt: "test",
    });
    expect(providerWithoutModel.success).toBe(false);

    const providerWithEmptyModel = await tool.inputSchema.safeParseAsync({
      ...detachedDirectoryWorkspace(existingCwd),
      settings: { modeId: "default" },
      title: "Short title",
      provider: "codex/",
      initialPrompt: "test",
    });
    expect(providerWithEmptyModel.success).toBe(false);

    const providerWithEmptyProvider = await tool.inputSchema.safeParseAsync({
      ...detachedDirectoryWorkspace(existingCwd),
      settings: { modeId: "default" },
      title: "Short title",
      provider: "/gpt-5.4",
      initialPrompt: "test",
    });
    expect(providerWithEmptyProvider.success).toBe(false);

    await expect(
      tool.handler({
        ...detachedDirectoryWorkspace(existingCwd),
        settings: { modeId: "default" },
        title: "Short title",
        provider: "codex/gpt-5.4",
        model: "gpt-5.4",
        initialPrompt: "test",
      }),
    ).rejects.toThrow("Unrecognized key");
  });

  it("accepts worktree workspace intent in create_agent input validation", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });
    const tool = registeredTool(server, "create_agent");

    const parsed = await tool.inputSchema.safeParseAsync({
      ...detachedWorktreeWorkspace(existingCwd, {
        kind: "checkout-pr",
        githubPrNumber: 42,
      }),
      title: "Short title",
      provider: "codex/gpt-5.4",
      initialPrompt: "test",
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts each create_worktree target kind", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });
    const tool = registeredTool(server, "create_worktree");

    for (const target of [
      { kind: "branch-off", worktreeSlug: "feature-x", baseBranch: "main" },
      { kind: "branch-off" },
      { kind: "checkout-branch", branch: "head-ref" },
      { kind: "checkout-pr", githubPrNumber: 42 },
    ] as const) {
      const parsed = await tool.inputSchema.safeParseAsync({ cwd: existingCwd, target });
      expect(parsed.success).toBe(true);
    }
  });

  it("rejects create_worktree without a target", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });
    const tool = registeredTool(server, "create_worktree");

    const parsed = await tool.inputSchema.safeParseAsync({});
    expect(parsed.success).toBe(false);
  });

  it("surfaces createAgent validation failures", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockRejectedValue(
      new Error("Working directory does not exist: /path/that/does/not/exist"),
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");

    await expect(
      tool.handler({
        ...detachedDirectoryWorkspace("/path/that/does/not/exist"),
        title: "Short title",
        provider: "codex/gpt-5.4",
        initialPrompt: "Do work",
      }),
    ).rejects.toThrow("Working directory does not exist");
  });

  it("passes caller-provided titles directly into createAgent", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "agent-123",
      cwd: REPO_CWD,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Fix auth bug" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    await tool.handler({
      ...detachedDirectoryWorkspace(existingCwd),
      title: "  Fix auth bug  ",
      provider: "codex/gpt-5.4",
      initialPrompt: "Do work",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: existingCwd,
        title: "Fix auth bug",
      }),
      undefined,
      { workspaceId: "workspace-created" },
    );
  });

  it("trims caller-provided titles before createAgent", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "agent-456",
      cwd: REPO_CWD,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Fix auth" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    await tool.handler({
      ...detachedDirectoryWorkspace(existingCwd),
      title: "  Fix auth  ",
      provider: "codex/gpt-5.4",
      initialPrompt: "Do work",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Fix auth",
      }),
      undefined,
      { workspaceId: "workspace-created" },
    );
  });

  it("requires provider/model and passes thinking and labels through createAgent", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "agent-789",
      cwd: REPO_CWD,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Config test", model: "claude-sonnet-4-20250514" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    await tool.handler({
      ...detachedDirectoryWorkspace(existingCwd),
      title: "Config test",
      initialPrompt: "Do work",
      provider: "codex/gpt-5.4",
      settings: { modeId: "auto", thinkingOptionId: "think-hard" },
      labels: { source: "mcp" },
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: existingCwd,
        title: "Config test",
        provider: "codex",
        model: "gpt-5.4",
        thinkingOptionId: "think-hard",
      }),
      undefined,
      {
        labels: { source: "mcp" },
        workspaceId: "workspace-created",
      },
    );
  });

  it("registers and broadcasts a workspace when create_agent creates a worktree", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const tempDir = await mkdtemp(join(tmpdir(), "paseo-mcp-worktree-"));
    const repoDir = join(tempDir, "repo");
    const paseoHome = join(tempDir, ".paseo");
    const broadcasts: string[] = [];
    const createdWorkspaceIds: string[] = [];
    const setupContinuations: Array<"workspace" | "agent" | undefined> = [];
    const startedAgentSetupIds: string[] = [];

    try {
      execFileSync("git", ["init", repoDir], { stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "commit.gpgsign", "false"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      await writeFile(join(repoDir, "README.md"), "hello\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["branch", "-M", "main"], { cwd: repoDir, stdio: "pipe" });

      spies.agentManager.createAgent.mockImplementation(async (config: { cwd: string }) => ({
        id: "agent-with-worktree",
        cwd: config.cwd,
        lifecycle: "idle",
        currentModeId: null,
        availableModes: [],
        config: { title: "Worktree agent" },
      }));

      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        providerSnapshotManager: createOpenCodeManager().manager,
        paseoHome,
        createPaseoWorktree: createPaseoWorktreeForMcpTest({
          paseoHome,
          broadcasts,
          createdWorkspaceIds,
          setupContinuations,
          startedAgentSetupIds,
        }),
        logger,
      });
      const tool = registeredTool(server, "create_agent");
      await tool.handler({
        ...detachedWorktreeWorkspace(repoDir, {
          kind: "branch-off",
          worktreeSlug: "agent-worktree",
          branchName: "feature/agent-worktree",
          baseBranch: "main",
        }),
        title: "Worktree agent",
        provider: "codex/gpt-5.4",
        initialPrompt: "Do work",
        background: true,
      });

      expect(broadcasts).toHaveLength(1);
      expect(createdWorkspaceIds).toHaveLength(1);
      expect(broadcasts[0]).toBe(createdWorkspaceIds[0]);
      expect(setupContinuations).toEqual(["agent"]);
      expect(startedAgentSetupIds).toEqual(["agent-with-worktree"]);
      const agentCwd = z.string().parse(spies.agentManager.createAgent.mock.calls[0]?.[0].cwd);
      const branchName = execFileSync("git", ["branch", "--show-current"], {
        cwd: agentCwd,
        stdio: "pipe",
      })
        .toString()
        .trim();
      expect(branchName).toBe("feature/agent-worktree");
      // The agent is stamped with the freshly created worktree's workspaceId so
      // workspaceId-scoped archive can find and tear it down later.
      expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: expect.stringContaining("agent-worktree"),
        }),
        undefined,
        { workspaceId: createdWorkspaceIds[0] },
      );
    } finally {
      await removeTempDir(tempDir);
    }
  });

  it("creates a create_agent branch-off worktree without invoking the legacy metadata branch rename", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const tempDir = await mkdtemp(join(tmpdir(), "paseo-mcp-agent-worktree-name-context-"));
    const repoDir = join(tempDir, "repo");
    const paseoHome = join(tempDir, ".paseo");
    const broadcasts: string[] = [];
    const workspaceGitService = {
      getSnapshot: vi.fn(async () => {
        throw new Error("agent metadata branch rename should not run");
      }),
    };

    try {
      execFileSync("git", ["init", repoDir], { stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "commit.gpgsign", "false"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      await writeFile(join(repoDir, "README.md"), "hello\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["branch", "-M", "main"], { cwd: repoDir, stdio: "pipe" });

      spies.agentManager.createAgent.mockImplementation(async (config: { cwd: string }) => ({
        id: "agent-auto-named-worktree",
        cwd: config.cwd,
        lifecycle: "idle",
        currentModeId: null,
        availableModes: [],
        config: { title: "Worktree agent" },
      }));

      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        providerSnapshotManager: createOpenCodeManager().manager,
        paseoHome,
        createPaseoWorktree: createPaseoWorktreeForMcpTest({ paseoHome, broadcasts }),
        workspaceGitService: workspaceGitService as unknown as Pick<
          WorkspaceGitService,
          "getSnapshot" | "listWorktrees"
        >,
        logger,
      });
      const tool = registeredTool(server, "create_agent");
      await tool.handler({
        ...detachedWorktreeWorkspace(repoDir, {
          kind: "branch-off",
          baseBranch: "main",
        }),
        title: "Worktree agent",
        provider: "codex/gpt-5.4",
        initialPrompt: "Fix workspace creation naming",
        background: true,
      });

      const agentCwd = z.string().parse(spies.agentManager.createAgent.mock.calls[0]?.[0].cwd);
      const initialBranch = execFileSync("git", ["branch", "--show-current"], {
        cwd: agentCwd,
        stdio: "pipe",
      })
        .toString()
        .trim();
      expect(initialBranch).not.toBe("");
      expect(initialBranch).not.toBe("main");
      await waitForUnexpectedWorkspaceNamingSideEffects();
      expect(workspaceGitService.getSnapshot).not.toHaveBeenCalled();
      expect(broadcasts).toHaveLength(1);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  it("auto-titles and renames an agent-created branch-off worktree from the initial prompt", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const tempDir = await mkdtemp(join(tmpdir(), "paseo-mcp-agent-worktree-auto-title-"));
    const repoDir = join(tempDir, "repo");
    const paseoHome = join(tempDir, ".paseo");
    const broadcasts: string[] = [];
    const createdWorkspaceIds: string[] = [];
    const workspaceRecords = new Map<string, PersistedWorkspaceRecord>();

    try {
      execFileSync("git", ["init", repoDir], { stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "commit.gpgsign", "false"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      await writeFile(join(repoDir, "README.md"), "hello\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["branch", "-M", "main"], { cwd: repoDir, stdio: "pipe" });

      spies.agentManager.createAgent.mockImplementation(async (config: { cwd: string }) => ({
        id: "agent-auto-titled-worktree",
        cwd: config.cwd,
        lifecycle: "idle",
        currentModeId: null,
        availableModes: [],
        config: { title: "Agent title" },
      }));

      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        providerSnapshotManager: createOpenCodeManager().manager,
        paseoHome,
        createPaseoWorktree: createPaseoWorktreeForMcpTest({
          paseoHome,
          broadcasts,
          createdWorkspaceIds,
          workspaceRecords,
          generateWorkspaceName: async () => ({
            title: "Workspace Auto Title Flow",
            branch: "workspace-auto-title-flow",
          }),
        }),
        logger,
      });
      const tool = registeredTool(server, "create_agent");
      await tool.handler({
        ...detachedWorktreeWorkspace(repoDir, {
          kind: "branch-off",
          branchName: "feat/placeholder-auto-title",
          baseBranch: "main",
        }),
        title: "Agent title",
        provider: "codex/gpt-5.4",
        initialPrompt: "Build a workspace auto title flow",
        background: true,
      });
      const workspaceId = z.string().parse(createdWorkspaceIds[0]);
      await waitForWorkspaceTitle(workspaceRecords, workspaceId, "Workspace Auto Title Flow");

      const agentCwd = z.string().parse(spies.agentManager.createAgent.mock.calls[0]?.[0].cwd);
      const workspace = workspaceRecords.get(workspaceId);
      const branchName = execFileSync("git", ["branch", "--show-current"], {
        cwd: agentCwd,
        stdio: "pipe",
      })
        .toString()
        .trim();
      const metadata = readPaseoWorktreeMetadata(agentCwd);

      expect(metadata).toMatchObject({
        version: 2,
        firstAgentBranchAutoName: {
          status: "attempted",
          placeholderBranchName: "feat/placeholder-auto-title",
        },
      });
      expect(branchName).toBe("workspace-auto-title-flow");
      expect(workspace).toMatchObject({
        title: "Workspace Auto Title Flow",
        branch: "workspace-auto-title-flow",
      });
    } finally {
      await removeTempDir(tempDir);
    }
  });

  it("keeps a manual workspace title when agent-created worktree naming finishes later", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const tempDir = await mkdtemp(join(tmpdir(), "paseo-mcp-agent-worktree-manual-title-"));
    const repoDir = join(tempDir, "repo");
    const paseoHome = join(tempDir, ".paseo");
    const broadcasts: string[] = [];
    const createdWorkspaceIds: string[] = [];
    const workspaceRecords = new Map<string, PersistedWorkspaceRecord>();

    try {
      execFileSync("git", ["init", repoDir], { stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "commit.gpgsign", "false"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      await writeFile(join(repoDir, "README.md"), "hello\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["branch", "-M", "main"], { cwd: repoDir, stdio: "pipe" });

      spies.agentManager.createAgent.mockImplementation(async (config: { cwd: string }) => ({
        id: "agent-manual-title-worktree",
        cwd: config.cwd,
        lifecycle: "idle",
        currentModeId: null,
        availableModes: [],
        config: { title: "Agent title" },
      }));

      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        providerSnapshotManager: createOpenCodeManager().manager,
        paseoHome,
        createPaseoWorktree: createPaseoWorktreeForMcpTest({
          paseoHome,
          broadcasts,
          createdWorkspaceIds,
          workspaceRecords,
          generateWorkspaceName: async () => ({
            title: "Generated Manual Race Title",
            branch: "generated-manual-race-title",
          }),
        }),
        workspaceRegistry: {
          get: async (workspaceId) => workspaceRecords.get(workspaceId) ?? null,
          upsert: async (record) => {
            workspaceRecords.set(record.workspaceId, record);
          },
        },
        emitWorkspaceUpdatesForWorkspaceIds: async (workspaceIds) => {
          broadcasts.push(...workspaceIds);
        },
        logger,
      });
      const createAgentTool = registeredTool(server, "create_agent");
      await createAgentTool.handler({
        ...detachedWorktreeWorkspace(repoDir, {
          kind: "branch-off",
          branchName: "feat/manual-title-placeholder",
          baseBranch: "main",
        }),
        title: "Agent title",
        provider: "codex/gpt-5.4",
        initialPrompt: "Keep the manually renamed workspace title",
        background: true,
      });
      const renameWorkspaceTool = registeredTool(server, "rename_workspace");
      await renameWorkspaceTool.handler({
        workspaceId: createdWorkspaceIds[0],
        title: "Manual Workspace Title",
      });
      const workspaceId = z.string().parse(createdWorkspaceIds[0]);
      await waitForWorkspaceBranch(workspaceRecords, workspaceId, "generated-manual-race-title");

      const agentCwd = z.string().parse(spies.agentManager.createAgent.mock.calls[0]?.[0].cwd);
      const workspace = workspaceRecords.get(workspaceId);
      const branchName = execFileSync("git", ["branch", "--show-current"], {
        cwd: agentCwd,
        stdio: "pipe",
      })
        .toString()
        .trim();

      expect(branchName).toBe("generated-manual-race-title");
      expect(workspace).toMatchObject({
        title: "Manual Workspace Title",
        branch: "generated-manual-race-title",
      });
    } finally {
      await removeTempDir(tempDir);
    }
  });

  it("uses create_agent title for the agent while still auto-titling the worktree workspace", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const tempDir = await mkdtemp(join(tmpdir(), "paseo-mcp-agent-title-workspace-title-"));
    const repoDir = join(tempDir, "repo");
    const paseoHome = join(tempDir, ".paseo");
    const broadcasts: string[] = [];
    const createdWorkspaceIds: string[] = [];
    const workspaceRecords = new Map<string, PersistedWorkspaceRecord>();

    try {
      execFileSync("git", ["init", repoDir], { stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "commit.gpgsign", "false"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      await writeFile(join(repoDir, "README.md"), "hello\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["branch", "-M", "main"], { cwd: repoDir, stdio: "pipe" });

      spies.agentManager.createAgent.mockImplementation(async (config: { cwd: string }) => ({
        id: "agent-explicit-title-worktree",
        cwd: config.cwd,
        lifecycle: "idle",
        currentModeId: null,
        availableModes: [],
        config: { title: "Explicit Agent Title" },
      }));

      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        providerSnapshotManager: createOpenCodeManager().manager,
        paseoHome,
        createPaseoWorktree: createPaseoWorktreeForMcpTest({
          paseoHome,
          broadcasts,
          createdWorkspaceIds,
          workspaceRecords,
          generateWorkspaceName: async () => ({
            title: "Generated Workspace Title",
            branch: "generated-workspace-title",
          }),
        }),
        logger,
      });
      const tool = registeredTool(server, "create_agent");
      await tool.handler({
        ...detachedWorktreeWorkspace(repoDir, {
          kind: "branch-off",
          branchName: "feat/agent-title-placeholder",
          baseBranch: "main",
        }),
        title: "Explicit Agent Title",
        provider: "codex/gpt-5.4",
        initialPrompt: "Generate the workspace title anyway",
        background: true,
      });
      const workspaceId = z.string().parse(createdWorkspaceIds[0]);
      await waitForWorkspaceTitle(workspaceRecords, workspaceId, "Generated Workspace Title");

      const workspace = workspaceRecords.get(workspaceId);
      expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Explicit Agent Title",
        }),
        undefined,
        { workspaceId },
      );
      expect(workspace).toMatchObject({
        title: "Generated Workspace Title",
        branch: "generated-workspace-title",
      });
    } finally {
      await removeTempDir(tempDir);
    }
  });

  it("auto-titles an agent-created directory workspace from the initial prompt", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const tempDir = await mkdtemp(join(tmpdir(), "paseo-mcp-agent-directory-auto-title-"));
    const workspaceDir = join(tempDir, "workspace");
    const workspaceRecords = new Map<string, PersistedWorkspaceRecord>();
    const broadcasts: string[] = [];
    const workspaceGitService = new WorkspaceGitServiceImpl({
      logger: createTestLogger(),
      paseoHome: join(tempDir, ".paseo"),
      deps: { github: createGitHubServiceStub() },
    });
    const workspaceAutoName = new WorkspaceAutoName({
      agentManager,
      workspaceRegistry: {
        get: async (workspaceId) => workspaceRecords.get(workspaceId) ?? null,
        upsert: async (record) => {
          workspaceRecords.set(record.workspaceId, record);
        },
      },
      workspaceGitService,
      providerSnapshotManager: createOpenCodeManager().manager,
      readDaemonConfig: () => ({ metadataGeneration: { providers: [] } }),
      gitMutation: createGitMutationService({
        workspaceGitService,
        github: createGitHubServiceStub(),
        logger: createTestLogger(),
      }),
      emitWorkspaceUpdateForCwd: async () => {},
      emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
        broadcasts.push(workspaceId);
      },
      logger: createTestLogger(),
      generateWorkspaceName: async () => ({
        title: "Directory Workspace Title",
        branch: "directory-workspace-title",
      }),
    });

    try {
      await mkdir(workspaceDir, { recursive: true });
      spies.agentManager.createAgent.mockImplementation(async (config: { cwd: string }) => ({
        id: "agent-directory-auto-title",
        cwd: config.cwd,
        lifecycle: "idle",
        currentModeId: null,
        availableModes: [],
        config: { title: "Directory agent" },
      }));

      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        providerSnapshotManager: createOpenCodeManager().manager,
        ensureWorkspaceForCreate: async (cwd, firstAgentContext) => {
          const workspace = createPersistedWorkspaceRecord({
            workspaceId: "workspace-directory-auto-title",
            projectId: "project-directory-auto-title",
            cwd,
            kind: "directory",
            displayName: "workspace",
            title: firstAgentContext?.prompt ?? null,
            createdAt: "2026-07-03T00:00:00.000Z",
            updatedAt: "2026-07-03T00:00:00.000Z",
          });
          workspaceRecords.set(workspace.workspaceId, workspace);
          if (firstAgentContext) {
            workspaceAutoName.scheduleForDirectory({
              workspaceId: workspace.workspaceId,
              cwd: workspace.cwd,
              firstAgentContext,
            });
          }
          return workspace.workspaceId;
        },
        logger,
      });
      const tool = registeredTool(server, "create_agent");
      await tool.handler({
        ...detachedDirectoryWorkspace(workspaceDir),
        title: "Directory agent",
        provider: "codex/gpt-5.4",
        initialPrompt: "Name a directory workspace from the prompt",
        background: true,
      });
      await waitForWorkspaceTitle(
        workspaceRecords,
        "workspace-directory-auto-title",
        "Directory Workspace Title",
      );

      expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: workspaceDir,
          title: "Directory agent",
        }),
        undefined,
        { workspaceId: "workspace-directory-auto-title" },
      );
      expect(workspaceRecords.get("workspace-directory-auto-title")).toMatchObject({
        title: "Directory Workspace Title",
        branch: null,
      });
      expect(broadcasts).toEqual(["workspace-directory-auto-title"]);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  it("auto-titles without renaming a create_agent checkout worktree from the initial prompt", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const tempDir = await mkdtemp(join(tmpdir(), "paseo-mcp-agent-checkout-name-context-"));
    const repoDir = join(tempDir, "repo");
    const paseoHome = join(tempDir, ".paseo");
    const broadcasts: string[] = [];
    const createdWorkspaceIds: string[] = [];
    const workspaceRecords = new Map<string, PersistedWorkspaceRecord>();
    let generateCalls = 0;
    const workspaceGitService = {
      getSnapshot: vi.fn(async () => {
        throw new Error("agent metadata branch rename should not run");
      }),
    };

    try {
      execFileSync("git", ["init", repoDir], { stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "commit.gpgsign", "false"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      await writeFile(join(repoDir, "README.md"), "hello\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["branch", "-M", "main"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["checkout", "-b", "existing-feature"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      await writeFile(join(repoDir, "feature.txt"), "feature\n");
      execFileSync("git", ["add", "feature.txt"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "feature"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["checkout", "main"], { cwd: repoDir, stdio: "pipe" });

      spies.agentManager.createAgent.mockImplementation(async (config: { cwd: string }) => ({
        id: "agent-checkout-worktree",
        cwd: config.cwd,
        lifecycle: "idle",
        currentModeId: null,
        availableModes: [],
        config: { title: "Checkout agent" },
      }));

      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        providerSnapshotManager: createOpenCodeManager().manager,
        paseoHome,
        createPaseoWorktree: createPaseoWorktreeForMcpTest({
          paseoHome,
          broadcasts,
          createdWorkspaceIds,
          workspaceRecords,
          generateWorkspaceName: async () => {
            generateCalls += 1;
            return {
              title: "Generated Checkout Workspace Title",
              branch: "generated-checkout-workspace-title",
            };
          },
        }),
        workspaceGitService: workspaceGitService as unknown as Pick<
          WorkspaceGitService,
          "getSnapshot" | "listWorktrees"
        >,
        logger,
      });
      const tool = registeredTool(server, "create_agent");
      await tool.handler({
        ...detachedWorktreeWorkspace(repoDir, {
          kind: "checkout-branch",
          branch: "existing-feature",
        }),
        title: "Checkout agent",
        provider: "codex/gpt-5.4",
        initialPrompt: "Rename this checkout from the prompt",
        background: true,
      });

      const agentCwd = z.string().parse(spies.agentManager.createAgent.mock.calls[0]?.[0].cwd);
      const workspaceId = z.string().parse(createdWorkspaceIds[0]);
      await waitForWorkspaceTitle(
        workspaceRecords,
        workspaceId,
        "Generated Checkout Workspace Title",
      );
      expect(
        execFileSync("git", ["branch", "--show-current"], { cwd: agentCwd, stdio: "pipe" })
          .toString()
          .trim(),
      ).toBe("existing-feature");
      expect(workspaceRecords.get(workspaceId)).toMatchObject({
        title: "Generated Checkout Workspace Title",
        branch: "existing-feature",
      });
      expect(readPaseoWorktreeMetadata(agentCwd)).toMatchObject({
        version: 1,
        baseRefName: "existing-feature",
      });
      expect(generateCalls).toBe(1);
      expect(workspaceGitService.getSnapshot).not.toHaveBeenCalled();
      expect(broadcasts).toEqual([workspaceId, workspaceId]);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  it("passes create_agent GitHub PR worktrees through workspace creation without metadata branch rename", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const startedAgentSetupIds: string[] = [];
    const createPaseoWorktree = vi.fn(
      async (
        input: CreatePaseoWorktreeInput,
        options?: Parameters<CreatePaseoWorktreeWorkflowFn>[1],
      ) => ({
        worktree: {
          branchName: "pr-123",
          worktreePath: "/tmp/worktrees/pr-123",
        },
        intent: {
          kind: "checkout-github-pr" as const,
          githubPrNumber: input.githubPrNumber ?? 123,
          headRef: "pr-123",
          baseRefName: "main",
        },
        workspace: {
          workspaceId: "ws-pr-123",
          projectId: REPO_CWD,
          cwd: "/tmp/worktrees/pr-123",
          kind: "worktree" as const,
          displayName: "pr-123",
          createdAt: "2026-04-30T00:00:00.000Z",
          updatedAt: "2026-04-30T00:00:00.000Z",
          archivedAt: null,
        },
        repoRoot: REPO_CWD,
        created: true,
        ...(options?.setupContinuation?.kind === "agent"
          ? {
              setupContinuation: {
                kind: "agent" as const,
                startAfterAgentCreate: ({ agentId }: { agentId: string }) => {
                  startedAgentSetupIds.push(agentId);
                },
              },
            }
          : {}),
      }),
    );
    const workspaceGitService = {
      getSnapshot: vi.fn(async () => {
        throw new Error("agent metadata branch rename should not run");
      }),
    };
    spies.agentManager.createAgent.mockImplementation(async (config: { cwd: string }) => ({
      id: "agent-pr-worktree",
      cwd: config.cwd,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "PR agent" },
    }));

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      createPaseoWorktree,
      workspaceGitService: workspaceGitService as unknown as Pick<
        WorkspaceGitService,
        "getSnapshot" | "listWorktrees"
      >,
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    await tool.handler({
      ...detachedWorktreeWorkspace(REPO_CWD, {
        kind: "checkout-pr",
        githubPrNumber: 123,
      }),
      title: "PR agent",
      provider: "codex/gpt-5.4",
      initialPrompt: "Rename this PR branch from prompt",
      background: true,
    });

    expect(createPaseoWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        githubPrNumber: 123,
        firstAgentContext: { prompt: "Rename this PR branch from prompt" },
      }),
      expect.objectContaining({
        setupContinuation: expect.objectContaining({ kind: "agent" }),
      }),
    );
    expect(startedAgentSetupIds).toEqual(["agent-pr-worktree"]);
    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/worktrees/pr-123" }),
      undefined,
      { workspaceId: "ws-pr-123" },
    );
    await waitForUnexpectedWorkspaceNamingSideEffects();
    expect(workspaceGitService.getSnapshot).not.toHaveBeenCalled();
  });

  it("registers and broadcasts a workspace when create_worktree creates a worktree", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const tempDir = await mkdtemp(join(tmpdir(), "paseo-mcp-create-worktree-"));
    const repoDir = join(tempDir, "repo");
    const paseoHome = join(tempDir, ".paseo");
    const broadcasts: string[] = [];
    const setupContinuations: Array<"workspace" | "agent" | undefined> = [];

    try {
      execFileSync("git", ["init", repoDir], { stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "commit.gpgsign", "false"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      await writeFile(join(repoDir, "README.md"), "hello\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["branch", "-M", "main"], { cwd: repoDir, stdio: "pipe" });
      const workspaceGitService = {
        getSnapshot: vi.fn(async () => null),
        listWorktrees: vi.fn(async () => []),
        resolveRepoRoot: vi.fn(async () => repoDir),
      };

      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        providerSnapshotManager: createOpenCodeManager().manager,
        paseoHome,
        createPaseoWorktree: createPaseoWorktreeForMcpTest({
          paseoHome,
          broadcasts,
          setupContinuations,
        }),
        workspaceGitService: workspaceGitService as unknown as Pick<
          WorkspaceGitService,
          "getSnapshot" | "listWorktrees" | "resolveRepoRoot"
        >,
        logger,
      });
      const tool = registeredTool(server, "create_worktree");
      const response = await tool.handler({
        cwd: repoDir,
        target: {
          kind: "branch-off",
          worktreeSlug: "tool-worktree",
          branchName: "feature/tool-worktree",
          baseBranch: "main",
        },
      });

      expect(response.structuredContent.branchName).toBe("feature/tool-worktree");
      expect(response.structuredContent.worktreePath).toContain("tool-worktree");
      expect(response.structuredContent.workspaceId).toBe(broadcasts[0]);
      expect(workspaceGitService.getSnapshot).not.toHaveBeenCalled();
      expect(workspaceGitService.listWorktrees).toHaveBeenCalledWith(repoDir, {
        force: true,
        reason: "mcp:create-worktree",
      });
      expect(setupContinuations).toEqual([undefined]);
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]).toMatch(/^wks_[0-9a-f]{16}$/);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  it("forces a workspace git snapshot refresh when archive_worktree deletes a worktree", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const tempDir = realpathSync.native(
      await mkdtemp(join(tmpdir(), "paseo-mcp-archive-worktree-")),
    );
    const repoDir = join(tempDir, "repo");
    const paseoHome = join(tempDir, ".paseo");

    try {
      execFileSync("git", ["init", repoDir], { stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "commit.gpgsign", "false"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      await writeFile(join(repoDir, "README.md"), "hello\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["branch", "-M", "main"], { cwd: repoDir, stdio: "pipe" });

      const workspaceGitService = {
        getSnapshot: vi.fn(async () => null),
        listWorktrees: vi.fn(async () => []),
        resolveRepoRoot: vi.fn(async () => repoDir),
      };
      const archiveWorkspaceRecord = vi.fn(async () => undefined);
      const emitWorkspaceUpdatesForWorkspaceIds = vi.fn(async () => undefined);
      const markWorkspaceArchiving = vi.fn();
      const clearWorkspaceArchiving = vi.fn();
      const listActiveWorkspaces = vi.fn(async () => []);
      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        providerSnapshotManager: createOpenCodeManager().manager,
        paseoHome,
        createPaseoWorktree: createPaseoWorktreeForMcpTest({ paseoHome, broadcasts: [] }),
        workspaceGitService: workspaceGitService as unknown as Pick<
          WorkspaceGitService,
          "getSnapshot" | "listWorktrees" | "resolveRepoRoot"
        >,
        findWorkspaceIdForCwd: vi.fn(async () => "ws-archive-tool-worktree"),
        listActiveWorkspaces,
        archiveWorkspaceRecord,
        emitWorkspaceUpdatesForWorkspaceIds,
        markWorkspaceArchiving,
        clearWorkspaceArchiving,
        github: createGitHubServiceStub(),
        logger,
      });
      const createTool = registeredTool(server, "create_worktree");
      const archiveTool = registeredTool(server, "archive_worktree");
      const created = await createTool.handler({
        cwd: repoDir,
        target: { kind: "branch-off", worktreeSlug: "archive-tool-worktree", baseBranch: "main" },
      });
      const createdWorktreePath = z.string().parse(created.structuredContent.worktreePath);
      listActiveWorkspaces.mockImplementation(async () => [
        { workspaceId: "ws-archive-tool-worktree", cwd: createdWorktreePath, kind: "worktree" },
      ]);
      archiveWorkspaceRecord.mockImplementation(async () => {
        listActiveWorkspaces.mockResolvedValueOnce([]);
      });
      workspaceGitService.getSnapshot.mockClear();

      await archiveTool.handler({
        cwd: repoDir,
        worktreePath: created.structuredContent.worktreePath,
      });

      expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith(repoDir, {
        force: true,
        reason: "archive-worktree",
      });
      expect(workspaceGitService.resolveRepoRoot).toHaveBeenCalledWith(repoDir);
      expect(workspaceGitService.listWorktrees).toHaveBeenCalledWith(repoDir, {
        force: true,
        reason: "mcp:archive-worktree",
      });
      expect(archiveWorkspaceRecord).toHaveBeenCalledWith("ws-archive-tool-worktree");
      expect(markWorkspaceArchiving).toHaveBeenCalledWith(
        ["ws-archive-tool-worktree"],
        expect.any(String),
      );
      expect(clearWorkspaceArchiving).toHaveBeenCalledWith(["ws-archive-tool-worktree"]);
      expect(Array.from(emitWorkspaceUpdatesForWorkspaceIds.mock.calls[0]?.[0] ?? [])).toEqual([
        "ws-archive-tool-worktree",
      ]);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  it("archives every workspace on a directory and removes the directory", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const tempDir = realpathSync.native(
      await mkdtemp(join(tmpdir(), "paseo-mcp-archive-worktree-multi-")),
    );
    const repoDir = join(tempDir, "repo");
    const paseoHome = join(tempDir, ".paseo");

    try {
      execFileSync("git", ["init", repoDir], { stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "commit.gpgsign", "false"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      await writeFile(join(repoDir, "README.md"), "hello\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["branch", "-M", "main"], { cwd: repoDir, stdio: "pipe" });

      const workspaceGitService = {
        getSnapshot: vi.fn(async () => null),
        listWorktrees: vi.fn(async () => []),
        resolveRepoRoot: vi.fn(async () => repoDir),
      };
      const archivedWorkspaceIds: string[] = [];
      let activeWorkspaces: Array<{
        workspaceId: string;
        cwd: string;
        kind: "worktree" | "local_checkout" | "directory";
      }> = [];
      const listActiveWorkspaces = vi.fn(async () => activeWorkspaces);
      const archiveWorkspaceRecord = createArchiveWorkspaceRecordMutator(
        activeWorkspaces,
        archivedWorkspaceIds,
      );
      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        providerSnapshotManager: createOpenCodeManager().manager,
        paseoHome,
        createPaseoWorktree: createPaseoWorktreeForMcpTest({ paseoHome, broadcasts: [] }),
        workspaceGitService: workspaceGitService as unknown as Pick<
          WorkspaceGitService,
          "getSnapshot" | "listWorktrees" | "resolveRepoRoot"
        >,
        findWorkspaceIdForCwd: vi.fn(async () => "ws-mcp-A"),
        listActiveWorkspaces,
        archiveWorkspaceRecord,
        emitWorkspaceUpdatesForWorkspaceIds: vi.fn(async () => undefined),
        markWorkspaceArchiving: vi.fn(),
        clearWorkspaceArchiving: vi.fn(),
        github: createGitHubServiceStub(),
        logger,
      });
      const createTool = registeredTool(server, "create_worktree");
      const archiveTool = registeredTool(server, "archive_worktree");
      const created = await createTool.handler({
        cwd: repoDir,
        target: { kind: "branch-off", worktreeSlug: "archive-multi-worktree", baseBranch: "main" },
      });
      const worktreePath = z.string().parse(created.structuredContent.worktreePath);

      // Populate the active workspaces with the real created path so archiveByScope
      // matches it against the worktree directory.
      activeWorkspaces = [
        { workspaceId: "ws-mcp-A", cwd: worktreePath, kind: "worktree" as const },
        { workspaceId: "ws-mcp-B", cwd: worktreePath, kind: "worktree" as const },
      ];

      await archiveTool.handler({
        cwd: repoDir,
        worktreePath,
      });

      expect(archivedWorkspaceIds).toContain("ws-mcp-A");
      expect(archivedWorkspaceIds).toContain("ws-mcp-B");
      await expect(access(worktreePath)).rejects.toThrow();
    } finally {
      await removeTempDir(tempDir);
    }
  });

  it("archives a worktree by slug", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const tempDir = realpathSync.native(
      await mkdtemp(join(tmpdir(), "paseo-mcp-archive-worktree-slug-")),
    );
    const repoDir = join(tempDir, "repo");
    const paseoHome = join(tempDir, ".paseo");

    try {
      execFileSync("git", ["init", repoDir], { stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "commit.gpgsign", "false"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      await writeFile(join(repoDir, "README.md"), "hello\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["branch", "-M", "main"], { cwd: repoDir, stdio: "pipe" });

      const workspaceGitService = {
        getSnapshot: vi.fn(async () => null),
        listWorktrees: vi.fn(async () => []),
        resolveRepoRoot: vi.fn(async () => repoDir),
      };
      const server = await createAgentMcpServer({
        agentManager,
        agentStorage,
        providerSnapshotManager: createOpenCodeManager().manager,
        paseoHome,
        createPaseoWorktree: createPaseoWorktreeForMcpTest({ paseoHome, broadcasts: [] }),
        workspaceGitService: workspaceGitService as unknown as Pick<
          WorkspaceGitService,
          "getSnapshot" | "listWorktrees" | "resolveRepoRoot"
        >,
        findWorkspaceIdForCwd: vi.fn(async () => "ws-archive-mcp"),
        listActiveWorkspaces: vi.fn(async () => []),
        archiveWorkspaceRecord: vi.fn(async () => undefined),
        emitWorkspaceUpdatesForWorkspaceIds: vi.fn(async () => undefined),
        markWorkspaceArchiving: vi.fn(),
        clearWorkspaceArchiving: vi.fn(),
        github: createGitHubServiceStub(),
        logger,
      });
      const createTool = registeredTool(server, "create_worktree");
      const archiveTool = registeredTool(server, "archive_worktree");
      const created = await createTool.handler({
        cwd: repoDir,
        target: { kind: "branch-off", worktreeSlug: "archive-slug-worktree", baseBranch: "main" },
      });

      const response = await archiveTool.handler({
        cwd: repoDir,
        worktreeSlug: "archive-slug-worktree",
      });

      expect(response.structuredContent).toEqual({ success: true });
      expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith(repoDir, {
        force: true,
        reason: "archive-worktree",
      });
      expect(workspaceGitService.resolveRepoRoot).toHaveBeenCalledWith(repoDir);
      expect(workspaceGitService.listWorktrees).toHaveBeenCalledWith(repoDir, {
        force: true,
        reason: "mcp:archive-worktree",
      });
      await expect(
        access(z.string().parse(created.structuredContent.worktreePath)),
      ).rejects.toThrow();
    } finally {
      await removeTempDir(tempDir);
    }
  });

  it("routes list_worktrees through WorkspaceGitService", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const workspaceGitService = {
      getSnapshot: vi.fn(async () => null),
      listWorktrees: vi.fn(async () => [
        {
          path: "/tmp/paseo/worktrees/repo/feature",
          branchName: "feature",
          createdAt: "2026-04-12T00:00:00.000Z",
        },
      ]),
    };
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      workspaceGitService: workspaceGitService as unknown as Pick<
        WorkspaceGitService,
        "getSnapshot" | "listWorktrees"
      >,
      logger,
    });
    const tool = registeredTool(server, "list_worktrees");

    const response = await tool.handler({ cwd: REPO_CWD });

    expect(workspaceGitService.listWorktrees).toHaveBeenCalledWith(REPO_CWD, {
      reason: "mcp:list-worktrees",
    });
    expect(response.structuredContent.worktrees).toEqual([
      {
        path: "/tmp/paseo/worktrees/repo/feature",
        branchName: "feature",
        createdAt: "2026-04-12T00:00:00.000Z",
      },
    ]);
  });

  it("accepts custom provider IDs in create_agent input validation", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });
    const tool = registeredTool(server, "create_agent");

    const parsed = await tool.inputSchema.safeParseAsync({
      ...detachedDirectoryWorkspace(existingCwd),
      title: "Custom provider agent",
      settings: { modeId: "default" },
      provider: "zai/custom-model",
      initialPrompt: "Do work",
    });

    expect(parsed.success).toBe(true);
  });

  it("allows caller agents to override cwd and applies caller context labels", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const baseDir = await mkdtemp(join(tmpdir(), "paseo-mcp-test-"));
    const subdir = join(baseDir, "subdir");
    await mkdir(subdir, { recursive: true });
    spies.agentManager.getAgent.mockReturnValue({
      id: "voice-agent",
      cwd: baseDir,
      workspaceId: "wks_voice",
      provider: "codex",
      currentModeId: "full-access",
    } as ManagedAgent);
    spies.agentManager.createAgent.mockResolvedValue({
      id: "child-agent",
      cwd: subdir,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Child" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "voice-agent",
      resolveCallerContext: () => ({
        childAgentDefaultLabels: { source: "voice" },
        allowCustomCwd: true,
      }),
      logger,
    });

    const tool = registeredTool(server, "create_agent");
    await tool.handler({
      ...subagentCurrentWorkspace("subdir"),
      title: "Child",
      provider: "codex/gpt-5.4",
      initialPrompt: "Do work",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: subdir,
      }),
      undefined,
      {
        labels: {
          [PARENT_AGENT_ID_LABEL]: "voice-agent",
          source: "voice",
        },
        workspaceId: "wks_voice",
      },
    );
    await rm(baseDir, { recursive: true, force: true });
  });

  it("rejects background from caller agents and defaults notify-on-finish on", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "parent-agent",
      cwd: existingCwd,
      workspaceId: "wks_parent",
      provider: "codex",
      currentModeId: "full-access",
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "parent-agent",
      logger,
    });

    const tool = registeredTool(server, "create_agent");
    await expect(
      tool.handler({
        ...subagentCurrentWorkspace(),
        title: "Child",
        provider: "codex/gpt-5.4",
        initialPrompt: "Do work",
        background: false,
      }),
    ).rejects.toThrow(/Unrecognized key/);

    const parsed = await tool.inputSchema.safeParseAsync({
      ...subagentCurrentWorkspace(),
      title: "Child",
      provider: "codex/gpt-5.4",
      initialPrompt: "Do work",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error("Expected caller create_agent input to parse");
    }
    expect(parsed.data).toMatchObject({
      relationship: { kind: "subagent" },
      workspace: { kind: "current" },
      notifyOnFinish: true,
    });
  });

  it("returns notify-on-finish guidance for caller-created agents", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const parentAgent = {
      id: "parent-agent",
      cwd: existingCwd,
      workspaceId: "wks_parent",
      provider: "codex",
      currentModeId: "full-access",
    } as ManagedAgent;
    const childAgent = {
      id: "child-agent",
      cwd: existingCwd,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Child" },
    } as ManagedAgent;
    spies.agentManager.getAgent.mockImplementation((agentId: string) => {
      if (agentId === "parent-agent") return parentAgent;
      if (agentId === "child-agent") return childAgent;
      return null;
    });
    spies.agentManager.createAgent.mockResolvedValue(childAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "parent-agent",
      logger,
    });

    const tool = registeredTool(server, "create_agent");
    const response = await tool.handler({
      ...subagentCurrentWorkspace(),
      title: "Child",
      provider: "codex/gpt-5.4",
      initialPrompt: "Do work",
    });

    expect(response.structuredContent.guidance).toBe(
      "You will get notified when the created agent finishes, errors, or needs permission. Do not poll for status; continue with other work until the notification arrives.",
    );
  });

  it("creates detached caller agents without a parent label", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "parent-agent",
      cwd: existingCwd,
      workspaceId: "wks_parent",
      provider: "codex",
      currentModeId: "full-access",
    } as ManagedAgent);
    spies.agentManager.createAgent.mockResolvedValue({
      id: "detached-agent",
      cwd: existingCwd,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Detached" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "parent-agent",
      logger,
    });

    const tool = registeredTool(server, "create_agent");
    await tool.handler({
      ...detachedCurrentWorkspace(),
      title: "Detached",
      provider: "codex/gpt-5.4",
      initialPrompt: "Take over",
      labels: {
        [PARENT_AGENT_ID_LABEL]: "spoofed-parent",
        source: "handoff",
      },
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: existingCwd,
      }),
      undefined,
      {
        labels: {
          source: "handoff",
        },
        workspaceId: "wks_parent",
      },
    );
  });

  it("accepts provider features from caller agents and passes them through createAgent", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "parent-agent",
      cwd: existingCwd,
      workspaceId: "wks_parent",
      provider: "claude",
      currentModeId: "bypassPermissions",
    } as ManagedAgent);
    spies.agentManager.createAgent.mockResolvedValue({
      id: "child-agent",
      cwd: existingCwd,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Child", featureValues: { fast_mode: true } },
    } as ManagedAgent);
    const providerSnapshot = createOpenCodeManager();
    providerSnapshot.stub.resolveCreateConfig.mockImplementation(async (input) => {
      const opts = input as { featureValues: Record<string, unknown> | undefined };
      return { modeId: undefined, featureValues: opts.featureValues };
    });

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      callerAgentId: "parent-agent",
      providerSnapshotManager: providerSnapshot.manager,
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    const input = {
      ...subagentCurrentWorkspace(),
      title: "Child",
      provider: "codex/gpt-5.4",
      initialPrompt: "Do work",
      settings: { features: { fast_mode: true } },
    };

    const parsed = await tool.inputSchema.safeParseAsync(input);
    expect(parsed.success).toBe(true);

    await tool.handler(input);

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        model: "gpt-5.4",
        featureValues: { fast_mode: true },
      }),
      undefined,
      {
        labels: {
          [PARENT_AGENT_ID_LABEL]: "parent-agent",
        },
        workspaceId: "wks_parent",
      },
    );
  });

  it("inherits the parent's workspaceId when an MCP child is created in the parent's working tree", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "mcp-workspace-inherit-"));
    const storage = new AgentStorage(join(workdir, "agents"), logger);
    const agentManager = new AgentManager({
      clients: createTestAgentClients(),
      registry: storage,
      logger,
    });

    try {
      const parent = await agentManager.createAgent(
        { provider: "codex", cwd: existingCwd },
        undefined,
        { workspaceId: "wks_parent" },
      );

      const server = await createAgentMcpServer({
        agentManager,
        agentStorage: storage,
        callerAgentId: parent.id,
        providerSnapshotManager: createOpenCodeManager().manager,
        logger,
      });
      const tool = registeredTool(server, "create_agent");
      const result = await tool.handler({
        ...subagentCurrentWorkspace(),
        title: "Child",
        provider: "codex/gpt-5.4",
        initialPrompt: "Do work",
      });

      const childId = z.object({ agentId: z.string() }).parse(result.structuredContent).agentId;
      const storedChild = await storage.get(childId);
      expect(storedChild?.workspaceId).toBe("wks_parent");
      expect(storedChild?.labels[PARENT_AGENT_ID_LABEL]).toBe(parent.id);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("delegates MCP injection to AgentManager and passes through an undefined agent ID", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "agent-injected-123",
      cwd: REPO_CWD,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Injected config test" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    await tool.handler({
      ...detachedDirectoryWorkspace(existingCwd),
      title: "Injected config test",
      settings: { modeId: "auto" },
      provider: "codex/gpt-5.4",
      initialPrompt: "Do work",
    });

    const [configArg, agentIdArg, optionsArg] = spies.agentManager.createAgent.mock.calls[0];
    expect(configArg).toMatchObject({
      cwd: existingCwd,
      title: "Injected config test",
    });
    expect(configArg.mcpServers).toBeUndefined();
    expect(agentIdArg).toBeUndefined();
    expect(optionsArg).toEqual({
      workspaceId: "workspace-created",
    });
  });

  it("rejects an explicit mode that is not valid for the target provider", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const providerSnapshot = createOpenCodeManager();
    providerSnapshot.stub.resolveCreateConfig.mockImplementation(async () => {
      throw new Error("resolver rejected mode");
    });
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: providerSnapshot.manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");

    await expect(
      tool.handler({
        ...detachedDirectoryWorkspace(existingCwd),
        title: "Bad mode",
        provider: "opencode/gpt-5.4",
        settings: { modeId: "bypassPermissions" },
        initialPrompt: "Do work",
      }),
    ).rejects.toThrow("resolver rejected mode");
    expect(spies.agentManager.createAgent).not.toHaveBeenCalled();
  });

  it("validates create_agent modes against the shared provider snapshot", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "child-agent",
      cwd: existingCwd,
      lifecycle: "idle",
      currentModeId: "dynamic",
      availableModes: [],
      config: { title: "Child" },
    } as ManagedAgent);
    const dynamicModes: AgentMode[] = [
      { id: "dynamic", label: "Dynamic", description: "Runtime mode" },
    ];
    const provStub = createProviderSnapshotManagerStub();
    provStub.listRegisteredProviderIds.mockReturnValue(["codex"]);
    provStub.listProviders.mockResolvedValue([
      buildSnapshotEntry({ provider: "codex", label: "Codex", modes: dynamicModes }),
    ]);
    provStub.getProvider.mockImplementation(async ({ provider }: { provider: AgentProvider }) =>
      buildSnapshotEntry({ provider, label: "Codex", modes: dynamicModes }),
    );
    provStub.listModes.mockResolvedValue(dynamicModes);
    provStub.resolveCreateConfig.mockImplementation(async (input) => {
      const opts = input as { requestedMode: string | undefined };
      expect(opts.requestedMode).toBe("dynamic");
      return { modeId: "dynamic", featureValues: undefined };
    });
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: provStub.manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");

    await tool.handler({
      ...detachedDirectoryWorkspace(existingCwd),
      title: "Dynamic mode",
      provider: "codex/gpt-5.4",
      settings: { modeId: "dynamic" },
      initialPrompt: "Do work",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ modeId: "dynamic" }),
      undefined,
      { workspaceId: "workspace-created" },
    );
  });

  it("passes resolver-returned mode and features into createAgent", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.createAgent.mockResolvedValue({
      id: "child-agent",
      cwd: existingCwd,
      lifecycle: "idle",
      currentModeId: "build",
      availableModes: [],
      config: { title: "Child", featureValues: { auto_accept: true } },
    } as ManagedAgent);
    const providerSnapshot = createOpenCodeManager();
    providerSnapshot.stub.resolveCreateConfig.mockResolvedValue({
      modeId: "build",
      featureValues: { auto_accept: true },
    });
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: providerSnapshot.manager,
      ensureWorkspaceForCreate,
      logger,
    });
    const tool = registeredTool(server, "create_agent");

    await tool.handler({
      ...detachedDirectoryWorkspace(existingCwd),
      title: "Legacy mode",
      provider: "opencode/gpt-5.4",
      settings: { modeId: "full-access" },
      initialPrompt: "Do work",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ modeId: "build", featureValues: { auto_accept: true } }),
      undefined,
      { workspaceId: "workspace-created" },
    );
  });

  it("passes the real parent agent and explicit unattended intent to the resolver", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const parentAgent = {
      id: "parent-agent",
      cwd: existingCwd,
      workspaceId: "wks_parent",
      provider: "claude",
      currentModeId: "bypassPermissions",
    } as ManagedAgent;
    spies.agentManager.getAgent.mockReturnValue(parentAgent);
    spies.agentManager.createAgent.mockResolvedValue({
      id: "child-agent",
      cwd: existingCwd,
      lifecycle: "idle",
      currentModeId: "resolver-mode",
      availableModes: [],
      config: { title: "Child" },
    } as ManagedAgent);
    const providerSnapshot = createOpenCodeManager();
    providerSnapshot.stub.resolveCreateConfig.mockResolvedValue({
      modeId: "resolver-mode",
      featureValues: { resolver_feature: true },
    });

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      callerAgentId: "parent-agent",
      providerSnapshotManager: providerSnapshot.manager,
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    await tool.handler({
      ...subagentCurrentWorkspace(),
      title: "Child",
      provider: "claude/claude-sonnet-4-20250514",
      initialPrompt: "Do work",
    });

    expect(providerSnapshot.stub.resolveCreateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ parent: parentAgent, unattended: false }),
    );
    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        modeId: "resolver-mode",
        featureValues: { resolver_feature: true },
      }),
      undefined,
      expect.any(Object),
    );
  });

  it("accepts an explicit valid mode across providers", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "parent-agent",
      cwd: existingCwd,
      workspaceId: "wks_parent",
      provider: "claude",
      currentModeId: "bypassPermissions",
    } as ManagedAgent);
    spies.agentManager.createAgent.mockResolvedValue({
      id: "child-agent",
      cwd: existingCwd,
      lifecycle: "idle",
      currentModeId: "build",
      availableModes: [],
      config: { title: "Child" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "parent-agent",
      logger,
    });
    const tool = registeredTool(server, "create_agent");
    await tool.handler({
      ...subagentCurrentWorkspace(),
      title: "Child",
      provider: "opencode/gpt-5.4",
      settings: { modeId: "build" },
      initialPrompt: "Do work",
    });

    expect(spies.agentManager.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ modeId: "build" }),
      undefined,
      expect.any(Object),
    );
  });
});

describe("send_agent_prompt MCP tool", () => {
  const logger = createTestLogger();
  const existingCwd = process.cwd();

  it("defaults agent-scoped prompts to background finish notifications", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const parentAgent = {
      id: "parent-agent",
      cwd: existingCwd,
      workspaceId: "wks_parent",
      provider: "codex",
      currentModeId: "full-access",
    } as ManagedAgent;
    const childAgent = {
      id: "child-agent",
      cwd: existingCwd,
      lifecycle: "running",
      currentModeId: null,
      availableModes: [],
      config: { title: "Child" },
    } as ManagedAgent;
    spies.agentManager.getAgent.mockImplementation((agentId: string) => {
      if (agentId === "parent-agent") return parentAgent;
      if (agentId === "child-agent") return childAgent;
      return null;
    });

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "parent-agent",
      logger,
    });

    const tool = registeredTool(server, "send_agent_prompt");
    const parsed = await tool.inputSchema.safeParseAsync({
      agentId: "child-agent",
      prompt: "Follow up",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error("Expected caller send_agent_prompt input to parse");
    }
    expect(parsed.data).toMatchObject({
      background: true,
      notifyOnFinish: true,
    });

    const response = await tool.handler(parsed.data as Record<string, unknown>);

    expect(spies.agentManager.subscribe).toHaveBeenCalledTimes(1);
    expect(spies.agentManager.waitForAgentEvent).not.toHaveBeenCalled();
    expect(response.structuredContent.guidance).toBe(
      "You will get notified when the prompted agent finishes, errors, or needs permission. Do not poll for status; continue with other work until the notification arrives.",
    );
  });

  it("keeps top-level prompts blocking by default", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "child-agent",
      cwd: existingCwd,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Child" },
    } as ManagedAgent);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });

    const tool = registeredTool(server, "send_agent_prompt");
    const parsed = await tool.inputSchema.safeParseAsync({
      agentId: "child-agent",
      prompt: "Follow up",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error("Expected top-level send_agent_prompt input to parse");
    }
    expect(parsed.data).toMatchObject({
      background: false,
      notifyOnFinish: false,
    });

    await tool.handler(parsed.data as Record<string, unknown>);

    expect(spies.agentManager.subscribe).not.toHaveBeenCalled();
    expect(spies.agentManager.waitForAgentEvent).toHaveBeenCalledWith(
      "child-agent",
      expect.objectContaining({ waitForActive: true }),
    );
  });

  it("does not arm a finish notification for blocking agent-scoped prompts", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const parentAgent = {
      id: "parent-agent",
      cwd: existingCwd,
      workspaceId: "wks_parent",
      provider: "codex",
      currentModeId: "full-access",
    } as ManagedAgent;
    const childAgent = {
      id: "child-agent",
      cwd: existingCwd,
      lifecycle: "idle",
      currentModeId: null,
      availableModes: [],
      config: { title: "Child" },
    } as ManagedAgent;
    spies.agentManager.getAgent.mockImplementation((agentId: string) => {
      if (agentId === "parent-agent") return parentAgent;
      if (agentId === "child-agent") return childAgent;
      return null;
    });

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "parent-agent",
      logger,
    });

    const tool = registeredTool(server, "send_agent_prompt");
    await invokeToolWithParsedInput(tool, {
      agentId: "child-agent",
      prompt: "Follow up",
      background: false,
    });

    expect(spies.agentManager.subscribe).not.toHaveBeenCalled();
    expect(spies.agentManager.waitForAgentEvent).toHaveBeenCalledWith(
      "child-agent",
      expect.objectContaining({ waitForActive: true }),
    );
  });
});

describe("update_agent MCP tool", () => {
  const logger = createTestLogger();

  it("does not register the replaced feature-specific MCP tool", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });

    expect(lookupTool(server, "set_agent_feature")).toBeUndefined();
  });

  it("updates runtime settings before metadata", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });
    const tool = registeredTool(server, "update_agent");
    const input = {
      agentId: "agent-1",
      name: "Updated agent",
      labels: { role: "worker" },
      settings: {
        modeId: "full-access",
        model: "gpt-5.4",
        thinkingOptionId: "high",
        features: { fast_mode: true },
      },
    };

    const parsed = await tool.inputSchema.safeParseAsync(input);
    expect(parsed.success).toBe(true);

    const response = await tool.handler(input);

    expect(spies.agentManager.setAgentMode).toHaveBeenCalledWith("agent-1", "full-access");
    expect(spies.agentManager.setAgentModel).toHaveBeenCalledWith("agent-1", "gpt-5.4");
    expect(spies.agentManager.setAgentThinkingOption).toHaveBeenCalledWith("agent-1", "high");
    expect(spies.agentManager.setAgentFeature).toHaveBeenCalledWith("agent-1", "fast_mode", true);
    expect(spies.agentManager.updateAgentMetadata).toHaveBeenCalledWith("agent-1", {
      title: "Updated agent",
      labels: { role: "worker" },
    });
    expect(response.structuredContent).toEqual({ success: true });
  });

  it("reports success for a no-op update with neither metadata nor settings", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });
    const tool = registeredTool(server, "update_agent");

    const response = await tool.handler({ agentId: "agent-1" });

    expect(response.structuredContent).toEqual({ success: true });
    expect(spies.agentManager.updateAgentMetadata).not.toHaveBeenCalled();
    expect(spies.agentManager.setAgentMode).not.toHaveBeenCalled();
    expect(spies.agentManager.setAgentModel).not.toHaveBeenCalled();
    expect(spies.agentManager.setAgentThinkingOption).not.toHaveBeenCalled();
    expect(spies.agentManager.setAgentFeature).not.toHaveBeenCalled();
  });

  it("does not update metadata when runtime settings fail", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.setAgentFeature.mockRejectedValue(new Error("unsupported feature"));
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });
    const tool = registeredTool(server, "update_agent");

    await expect(
      tool.handler({
        agentId: "agent-1",
        name: "Should not persist",
        labels: { role: "worker" },
        settings: { features: { fast_mode: true } },
      }),
    ).rejects.toThrow("unsupported feature");

    expect(spies.agentStorage.get).not.toHaveBeenCalled();
    expect(spies.agentManager.updateAgentMetadata).not.toHaveBeenCalled();
  });
});

describe("rename_workspace MCP tool", () => {
  const logger = createTestLogger();

  it("renames the caller workspace when workspaceId is omitted", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "wks_parent",
      projectId: "proj_parent",
      cwd: REPO_CWD,
      kind: "local_checkout",
      displayName: "main",
      createdAt: "2026-07-03T09:00:00.000Z",
      updatedAt: "2026-07-03T09:00:00.000Z",
    });
    const workspaces = new Map([[workspace.workspaceId, workspace]]);
    const upsertedWorkspaces: PersistedWorkspaceRecord[] = [];
    const emittedWorkspaceIds: string[][] = [];
    spies.agentManager.getAgent.mockReturnValue(
      createManagedAgent({
        id: "parent-agent",
        cwd: REPO_CWD,
        workspaceId: workspace.workspaceId,
      }),
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      workspaceRegistry: {
        get: async (workspaceId) => workspaces.get(workspaceId) ?? null,
        upsert: async (record) => {
          upsertedWorkspaces.push(record);
          workspaces.set(record.workspaceId, record);
        },
      },
      emitWorkspaceUpdatesForWorkspaceIds: async (workspaceIds) => {
        emittedWorkspaceIds.push(Array.from(workspaceIds));
      },
      callerAgentId: "parent-agent",
      logger,
    });
    const tool = registeredTool(server, "rename_workspace");

    const response = await invokeToolWithParsedInput(tool, {
      title: "  Payments flow  ",
    });

    expect(upsertedWorkspaces).toEqual([
      {
        ...workspace,
        title: "Payments flow",
        updatedAt: expect.any(String),
      },
    ]);
    expect(response.structuredContent).toEqual({
      success: true,
      workspaceId: "wks_parent",
      title: "Payments flow",
    });
    expect(emittedWorkspaceIds).toEqual([["wks_parent"]]);
  });

  it("renames an explicit workspace outside the caller workspace", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const parentWorkspace = createPersistedWorkspaceRecord({
      workspaceId: "wks_parent",
      projectId: "proj_parent",
      cwd: REPO_CWD,
      kind: "local_checkout",
      displayName: "main",
      createdAt: "2026-07-03T09:00:00.000Z",
      updatedAt: "2026-07-03T09:00:00.000Z",
    });
    const otherWorkspace = createPersistedWorkspaceRecord({
      workspaceId: "wks_other",
      projectId: "proj_other",
      cwd: TARGET_CWD,
      kind: "local_checkout",
      displayName: "other",
      createdAt: "2026-07-03T09:00:00.000Z",
      updatedAt: "2026-07-03T09:00:00.000Z",
    });
    const workspaces = new Map([
      [parentWorkspace.workspaceId, parentWorkspace],
      [otherWorkspace.workspaceId, otherWorkspace],
    ]);
    const upsertedWorkspaces: PersistedWorkspaceRecord[] = [];
    const emittedWorkspaceIds: string[][] = [];
    spies.agentManager.getAgent.mockReturnValue(
      createManagedAgent({
        id: "parent-agent",
        cwd: REPO_CWD,
        workspaceId: parentWorkspace.workspaceId,
      }),
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      workspaceRegistry: {
        get: async (workspaceId) => workspaces.get(workspaceId) ?? null,
        upsert: async (record) => {
          upsertedWorkspaces.push(record);
          workspaces.set(record.workspaceId, record);
        },
      },
      emitWorkspaceUpdatesForWorkspaceIds: async (workspaceIds) => {
        emittedWorkspaceIds.push(Array.from(workspaceIds));
      },
      callerAgentId: "parent-agent",
      logger,
    });
    const tool = registeredTool(server, "rename_workspace");

    const response = await invokeToolWithParsedInput(tool, {
      workspaceId: "wks_other",
      title: "Payments flow",
    });

    expect(upsertedWorkspaces).toEqual([
      {
        ...otherWorkspace,
        title: "Payments flow",
        updatedAt: expect.any(String),
      },
    ]);
    expect(response.structuredContent).toEqual({
      success: true,
      workspaceId: "wks_other",
      title: "Payments flow",
    });
    expect(emittedWorkspaceIds).toEqual([["wks_other"]]);
  });

  it("rejects archived workspaces", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "wks_archived",
      projectId: "proj_parent",
      cwd: REPO_CWD,
      kind: "local_checkout",
      displayName: "main",
      archivedAt: "2026-07-03T10:00:00.000Z",
      createdAt: "2026-07-03T09:00:00.000Z",
      updatedAt: "2026-07-03T10:00:00.000Z",
    });
    const workspaces = new Map([[workspace.workspaceId, workspace]]);
    const upsertedWorkspaces: PersistedWorkspaceRecord[] = [];
    const emittedWorkspaceIds: string[][] = [];
    spies.agentManager.getAgent.mockReturnValue(
      createManagedAgent({
        id: "parent-agent",
        cwd: REPO_CWD,
        workspaceId: workspace.workspaceId,
      }),
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      workspaceRegistry: {
        get: async (workspaceId) => workspaces.get(workspaceId) ?? null,
        upsert: async (record) => {
          upsertedWorkspaces.push(record);
          workspaces.set(record.workspaceId, record);
        },
      },
      emitWorkspaceUpdatesForWorkspaceIds: async (workspaceIds) => {
        emittedWorkspaceIds.push(Array.from(workspaceIds));
      },
      callerAgentId: "parent-agent",
      logger,
    });
    const tool = registeredTool(server, "rename_workspace");

    await expect(
      invokeToolWithParsedInput(tool, {
        title: "Payments flow",
      }),
    ).rejects.toThrow("Workspace wks_archived is archived");
    expect(upsertedWorkspaces).toEqual([]);
    expect(emittedWorkspaceIds).toEqual([]);
  });
});

describe("create_schedule MCP tool", () => {
  const logger = createTestLogger();

  it("requires provider for schedules", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const createOrReplace = vi.fn(async (input: CreateScheduleInput) =>
      createStoredSchedule(input),
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { createOrReplace } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "create_schedule");

    await expect(
      tool.handler({
        prompt: "say hello",
        cron: "*/5 * * * *",
        name: "Default schedule",
      }),
    ).rejects.toThrow("provider is required when target is new-agent");
    expect(createOrReplace).not.toHaveBeenCalled();
  });

  it("keeps create_schedule provider overrides compatible with provider and provider/model forms", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const createOrReplace = vi.fn(async (input: CreateScheduleInput) =>
      createStoredSchedule(input),
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { createOrReplace } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "create_schedule");

    await tool.handler({
      prompt: "say hello",
      cron: "*/5 * * * *",
      provider: "codex",
    });
    await tool.handler({
      prompt: "say hello again",
      cron: "*/10 * * * *",
      provider: "codex/gpt-5.4",
    });

    expect(createOrReplace).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target: {
          type: "new-agent",
          config: {
            provider: "codex",
            cwd: process.cwd(),
          },
        },
      }),
    );
    expect(createOrReplace).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: {
          type: "new-agent",
          config: {
            provider: "codex",
            cwd: process.cwd(),
            model: "gpt-5.4",
          },
        },
      }),
    );
  });

  it("returns create_schedule structured content with inherited feature values", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "parent-agent",
      provider: "opencode",
      cwd: REPO_CWD,
      lifecycle: "idle",
      currentModeId: "build",
      availableModes: [],
      config: {
        title: "Parent agent",
        model: "openai/gpt-5.5",
        featureValues: { auto_accept: true },
      },
    } as ManagedAgent);
    const createOrReplace = vi.fn(async (input: CreateScheduleInput) =>
      createStoredSchedule(input),
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { createOrReplace } as unknown as ScheduleService,
      callerAgentId: "parent-agent",
      logger,
    });
    const tool = registeredTool(server, "create_schedule");

    const response = await tool.handler({
      prompt: "say hello",
      cron: "*/5 * * * *",
      provider: "opencode/openai/gpt-5.5",
    });

    expect(response.structuredContent.target).toMatchObject({
      type: "new-agent",
      config: { featureValues: { auto_accept: true } },
    });
  });

  it("passes timezone through cron create_schedule input", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const createOrReplace = vi.fn(async (scheduleInput: CreateScheduleInput) =>
      createStoredSchedule(scheduleInput),
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { createOrReplace } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "create_schedule");

    await invokeToolWithParsedInput(tool, {
      prompt: "say hello",
      cron: "0 9 * * 1-5",
      timezone: "  America/New_York  ",
      provider: "codex",
    });

    expect(createOrReplace).toHaveBeenCalledWith(
      expect.objectContaining({
        cadence: {
          type: "cron",
          expression: "0 9 * * 1-5",
          timezone: "America/New_York",
        },
      }),
    );
  });

  it("rejects removed create_schedule every input", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const createOrReplace = vi.fn();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { createOrReplace } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "create_schedule");

    const parsed = await tool.inputSchema.safeParseAsync({
      prompt: "say hello",
      every: "10m",
      provider: "codex",
    });
    expect(parsed.success).toBe(false);

    expect(createOrReplace).not.toHaveBeenCalled();
  });

  it("rejects create_schedule without cron", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const createOrReplace = vi.fn();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { createOrReplace } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "create_schedule");

    await expect(
      tool.handler({
        prompt: "say hello",
        provider: "codex",
      }),
    ).rejects.toThrow(/cron/);

    expect(createOrReplace).not.toHaveBeenCalled();
  });

  it.each(["", "   "])("rejects create_schedule blank timezone %#", async (timezone) => {
    const { agentManager, agentStorage } = createTestDeps();
    const createOrReplace = vi.fn();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { createOrReplace } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "create_schedule");

    await expect(
      invokeToolWithParsedInput(tool, {
        prompt: "say hello",
        cron: "0 9 * * 1-5",
        timezone,
        provider: "codex",
      }),
    ).rejects.toThrow();

    expect(createOrReplace).not.toHaveBeenCalled();
  });
});

describe("create_heartbeat MCP tool", () => {
  const logger = createTestLogger();

  it("creates a self-targeted cron heartbeat", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue({
      id: "parent-agent",
      provider: "codex",
      cwd: REPO_CWD,
      lifecycle: "idle",
      currentModeId: "build",
      availableModes: [],
      config: { title: "Parent agent" },
    } as ManagedAgent);
    const createOrReplace = vi.fn(async (input: CreateScheduleInput) =>
      createStoredSchedule(input),
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { createOrReplace } as unknown as ScheduleService,
      callerAgentId: "parent-agent",
      logger,
    });
    const tool = registeredTool(server, "create_heartbeat");

    await invokeToolWithParsedInput(tool, {
      prompt: "check status",
      cron: "*/15 * * * *",
      timezone: "America/New_York",
      name: "status heartbeat",
    });

    expect(createOrReplace).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "check status",
        cadence: {
          type: "cron",
          expression: "*/15 * * * *",
          timezone: "America/New_York",
        },
        target: { type: "agent", agentId: "parent-agent" },
        name: "status heartbeat",
      }),
    );
  });

  it("requires an agent-scoped session", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const createOrReplace = vi.fn();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { createOrReplace } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "create_heartbeat");

    await expect(
      tool.handler({
        prompt: "check status",
        cron: "*/15 * * * *",
      }),
    ).rejects.toThrow("create_heartbeat requires an agent-scoped session");

    expect(createOrReplace).not.toHaveBeenCalled();
  });
});

describe("update_schedule MCP tool", () => {
  const logger = createTestLogger();

  function makeStoredSchedule(): StoredSchedule {
    return {
      id: "schedule-1",
      name: "test schedule",
      prompt: "say hello",
      cadence: { type: "every", everyMs: 300000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: "/tmp" } },
      status: "active",
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
      nextRunAt: "2026-04-11T00:05:00.000Z",
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    };
  }

  it("calls scheduleService.update with correct input", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const stored = makeStoredSchedule();
    const update = vi.fn(async (_input: UpdateScheduleInput) => ({
      ...stored,
      name: "updated name",
      prompt: "new prompt",
      updatedAt: "2026-04-11T01:00:00.000Z",
    }));
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { update } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "update_schedule");

    await tool.handler({
      id: "schedule-1",
      name: "updated name",
      prompt: "new prompt",
    });

    expect(update).toHaveBeenCalledWith({
      id: "schedule-1",
      name: "updated name",
      prompt: "new prompt",
    });
  });

  it("converts every to cadence", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const stored = makeStoredSchedule();
    const update = vi.fn(async (_input: UpdateScheduleInput) => stored);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { update } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "update_schedule");

    await tool.handler({
      id: "schedule-1",
      every: "10m",
    });

    expect(update).toHaveBeenCalledWith({
      id: "schedule-1",
      cadence: { type: "every", everyMs: 600000 },
    });
  });

  it("passes timezone through cron update_schedule input", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const stored = makeStoredSchedule();
    const update = vi.fn(async (_input: UpdateScheduleInput) => stored);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { update } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "update_schedule");

    await invokeToolWithParsedInput(tool, {
      id: "schedule-1",
      cron: "0 9 * * 1-5",
      timezone: "Europe/Zurich",
    });

    expect(update).toHaveBeenCalledWith({
      id: "schedule-1",
      cadence: {
        type: "cron",
        expression: "0 9 * * 1-5",
        timezone: "Europe/Zurich",
      },
    });
  });

  it("accepts a blank cron field when updating every cadence", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const stored = makeStoredSchedule();
    const update = vi.fn(async (_input: UpdateScheduleInput) => stored);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { update } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "update_schedule");

    await invokeToolWithParsedInput(tool, {
      id: "schedule-1",
      every: "10m",
      cron: "",
    });

    expect(update).toHaveBeenCalledWith({
      id: "schedule-1",
      cadence: { type: "every", everyMs: 600000 },
    });
  });

  it.each([
    {
      label: "whitespace cron field",
      input: { id: "schedule-1", every: "10m", cron: "   " },
      cadence: { type: "every", everyMs: 600000 },
    },
    {
      label: "blank every field for cron cadence",
      input: { id: "schedule-1", every: "", cron: "*/10 * * * *" },
      cadence: { type: "cron", expression: "*/10 * * * *" },
    },
    {
      label: "whitespace every field for cron cadence",
      input: { id: "schedule-1", every: "   ", cron: "*/10 * * * *" },
      cadence: { type: "cron", expression: "*/10 * * * *" },
    },
  ])("normalizes update_schedule blank cadence input for $label", async ({ input, cadence }) => {
    const { agentManager, agentStorage } = createTestDeps();
    const stored = makeStoredSchedule();
    const update = vi.fn(async (_input: UpdateScheduleInput) => stored);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { update } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "update_schedule");

    await invokeToolWithParsedInput(tool, input);

    expect(update).toHaveBeenCalledWith({
      id: "schedule-1",
      cadence,
    });
  });

  it("rejects both every and cron", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const update = vi.fn();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { update } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "update_schedule");

    await expect(
      tool.handler({
        id: "schedule-1",
        every: "5m",
        cron: "* * * * *",
      }),
    ).rejects.toThrow("Specify at most one of every or cron");
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects update_schedule timezone without cron", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const update = vi.fn();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { update } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "update_schedule");

    await expect(
      invokeToolWithParsedInput(tool, {
        id: "schedule-1",
        every: "10m",
        timezone: "Europe/Zurich",
      }),
    ).rejects.toThrow("timezone can only be used with cron");

    expect(update).not.toHaveBeenCalled();
  });

  it.each(["", "   "])("rejects update_schedule blank timezone %#", async (timezone) => {
    const { agentManager, agentStorage } = createTestDeps();
    const update = vi.fn();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { update } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "update_schedule");

    await expect(
      invokeToolWithParsedInput(tool, {
        id: "schedule-1",
        cron: "0 9 * * 1-5",
        timezone,
      }),
    ).rejects.toThrow();

    expect(update).not.toHaveBeenCalled();
  });

  it("passes new-agent config and expiry updates", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const stored = makeStoredSchedule();
    const update = vi.fn(async (_input: UpdateScheduleInput) => stored);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { update } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "update_schedule");

    await tool.handler({
      id: "schedule-1",
      provider: "codex/gpt-5.4",
      mode: "full-access",
      cwd: "/home/user/project",
      expiresIn: "1h",
    });

    const updateInput = update.mock.calls[0]?.[0];
    expect(updateInput).toMatchObject({
      id: "schedule-1",
      newAgentConfig: {
        provider: "codex",
        model: "gpt-5.4",
        modeId: "full-access",
        cwd: "/home/user/project",
      },
    });
    expect(updateInput?.expiresAt).toEqual(expect.any(String));
  });

  it("clears model, mode, max runs, and expiry", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const stored = makeStoredSchedule();
    const update = vi.fn(async (_input: UpdateScheduleInput) => stored);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { update } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "update_schedule");

    await tool.handler({
      id: "schedule-1",
      model: null,
      mode: null,
      maxRuns: null,
      clearExpires: true,
    });

    expect(update).toHaveBeenCalledWith({
      id: "schedule-1",
      maxRuns: null,
      expiresAt: null,
      newAgentConfig: {
        model: null,
        modeId: null,
      },
    });
  });

  it("rejects conflicting model and expiry inputs", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const update = vi.fn();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { update } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "update_schedule");

    await expect(
      tool.handler({
        id: "schedule-1",
        provider: "codex/gpt-5.4",
        model: "gpt-5.5",
      }),
    ).rejects.toThrow("Conflicting model values provided");
    await expect(
      tool.handler({
        id: "schedule-1",
        expiresIn: "1h",
        clearExpires: true,
      }),
    ).rejects.toThrow("Specify at most one of expiresIn or clearExpires");
    expect(update).not.toHaveBeenCalled();
  });
});

describe("schedule_logs MCP tool", () => {
  const logger = createTestLogger();

  function makeRun(overrides: Partial<{ id: string; status: string }> = {}) {
    return {
      id: overrides.id ?? "run-1",
      scheduledFor: "2026-04-11T00:00:00.000Z",
      startedAt: "2026-04-11T00:00:01.000Z",
      endedAt: "2026-04-11T00:00:05.000Z",
      status: overrides.status ?? "succeeded",
      agentId: null,
      output: "done",
      error: null,
    };
  }

  it("returns runs for a schedule", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const runs = [makeRun({ id: "run-1" }), makeRun({ id: "run-2", status: "failed" })];
    const logs = vi.fn(async (_id: string) => runs);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      scheduleService: { logs } as unknown as ScheduleService,
      logger,
    });
    const tool = registeredTool(server, "schedule_logs");

    const result = await tool.handler({ id: "schedule-1" });

    expect(logs).toHaveBeenCalledWith("schedule-1");
    expect(result.structuredContent).toEqual({ runs });
  });

  it("throws when schedule service is not configured", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });
    const tool = registeredTool(server, "schedule_logs");

    await expect(tool.handler({ id: "schedule-1" })).rejects.toThrow(
      "Schedule service is not configured",
    );
  });
});

describe("provider listing MCP tool", () => {
  const logger = createTestLogger();

  it("returns providers from the registry, including custom providers", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const provStub = createProviderSnapshotManagerStub();
    provStub.listRegisteredProviderIds.mockReturnValue(["claude", "zai"]);
    provStub.listProviders.mockResolvedValue([
      buildSnapshotEntry({
        provider: "claude",
        label: "Claude",
        description: "Test provider",
        modes: [{ id: "default", label: "Default", description: "Built-in mode" }],
      }),
      buildSnapshotEntry({
        provider: "zai" as AgentProvider,
        label: "ZAI",
        description: "Custom Claude profile",
        defaultModeId: "default",
        modes: [{ id: "default", label: "Default", description: "Custom mode" }],
      }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: provStub.manager,
      logger,
    });
    const tool = registeredTool(server, "list_providers");
    const response = await tool.handler({});
    const modelVisibleText = String(response.content[0]?.text);

    expect(response.structuredContent).toEqual({
      providers: [
        {
          id: "claude",
          label: "Claude",
          description: "Test provider",
          enabled: true,
          status: "available",
          modes: [{ id: "default", label: "Default", description: "Built-in mode" }],
        },
        {
          id: "zai",
          label: "ZAI",
          status: "available",
          description: "Custom Claude profile",
          enabled: true,
          modes: [{ id: "default", label: "Default", description: "Custom mode" }],
        },
      ],
    });
    expect(modelVisibleText).toContain("providers_count=2");
    expect(modelVisibleText).toContain("providers_ids=claude,zai");
    expect(modelVisibleText).toContain('"providers"');
  });

  it("returns provider modes from the shared snapshot catalog", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const provStub = createProviderSnapshotManagerStub();
    provStub.listRegisteredProviderIds.mockReturnValue(["codex"]);
    provStub.listProviders.mockResolvedValue([
      buildSnapshotEntry({
        provider: "codex",
        label: "Codex",
        modes: [{ id: "dynamic", label: "Dynamic", description: "Runtime mode" }],
      }),
    ]);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: provStub.manager,
      logger,
    });
    const tool = registeredTool(server, "list_providers");

    const response = await tool.handler({});

    expect(response.structuredContent.providers).toEqual([
      expect.objectContaining({
        id: "codex",
        modes: [{ id: "dynamic", label: "Dynamic", description: "Runtime mode" }],
      }),
    ]);
  });

  it("returns disabled providers with metadata without checking availability", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const provStub = createProviderSnapshotManagerStub();
    provStub.listRegisteredProviderIds.mockReturnValue(["codex"]);
    provStub.listProviders.mockResolvedValue([
      buildSnapshotEntry({
        provider: "codex",
        label: "Codex",
        description: "OpenAI coding agent",
        enabled: false,
        modes: [{ id: "read-only", label: "Read Only", description: "No edits" }],
      }),
    ]);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: provStub.manager,
      logger,
    });
    const tool = registeredTool(server, "list_providers");
    const response = await tool.handler({});

    expect(response.structuredContent).toEqual({
      providers: [
        {
          id: "codex",
          label: "Codex",
          description: "OpenAI coding agent",
          enabled: false,
          status: "unavailable",
          modes: [],
        },
      ],
    });
  });
});

describe("provider MCP tools", () => {
  const logger = createTestLogger();

  it("does not register the replaced feature-specific provider discovery MCP tool", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });

    expect(lookupTool(server, "list_provider_features")).toBeUndefined();
  });

  it("inspects provider features for a draft agent configuration", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.listDraftFeatures.mockResolvedValue([
      {
        type: "toggle",
        id: "fast_mode",
        label: "Fast mode",
        value: false,
      },
    ]);
    const provStub = createProviderSnapshotManagerStub();
    provStub.listRegisteredProviderIds.mockReturnValue(["codex"]);
    const codexEntry = buildSnapshotEntry({
      provider: "codex",
      label: "Codex",
      description: "OpenAI coding agent",
      modes: [{ id: "full-access", label: "Full Access", description: "Can edit files" }],
    });
    provStub.listProviders.mockResolvedValue([codexEntry]);
    provStub.getProvider.mockResolvedValue(codexEntry);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: provStub.manager,
      logger,
    });
    const tool = registeredTool(server, "inspect_provider");
    const input = {
      provider: "codex/gpt-5.4",
      cwd: "~/repo",
      settings: {
        modeId: "full-access",
        thinkingOptionId: "high",
        features: { fast_mode: true },
      },
    };

    const parsed = await tool.inputSchema.safeParseAsync(input);
    expect(parsed.success).toBe(true);

    const response = await tool.handler(input);

    expect(spies.agentManager.listDraftFeatures).toHaveBeenCalledWith({
      provider: "codex",
      cwd: expect.stringContaining("repo"),
      modeId: "full-access",
      model: "gpt-5.4",
      thinkingOptionId: "high",
      featureValues: { fast_mode: true },
    });
    expect(response.structuredContent).toEqual({
      provider: "codex",
      label: "Codex",
      description: "OpenAI coding agent",
      enabled: true,
      status: "available",
      modes: [{ id: "full-access", label: "Full Access", description: "Can edit files" }],
      selectedModel: "gpt-5.4",
      features: [
        {
          type: "toggle",
          id: "fast_mode",
          label: "Fast mode",
          value: false,
        },
      ],
    });
  });

  it("rejects disabled providers without fetching models", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const provStub = createProviderSnapshotManagerStub();
    provStub.listRegisteredProviderIds.mockReturnValue(["codex"]);
    provStub.listModels.mockRejectedValue(new Error("Provider 'codex' is disabled"));
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: provStub.manager,
      logger,
    });
    const tool = registeredTool(server, "list_models");

    await expect(tool.handler({ provider: "codex" })).rejects.toThrow(
      "Provider 'codex' is disabled",
    );
  });

  it("inspect_provider rejects disabled providers without fetching models", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const provStub = createProviderSnapshotManagerStub();
    provStub.listRegisteredProviderIds.mockReturnValue(["codex"]);
    provStub.getProvider.mockResolvedValue(
      buildSnapshotEntry({ provider: "codex", label: "Codex", enabled: false }),
    );
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: provStub.manager,
      logger,
    });
    const tool = registeredTool(server, "inspect_provider");

    await expect(tool.handler({ provider: "codex", cwd: "~/repo" })).rejects.toThrow(
      "Provider 'codex' is disabled",
    );
  });
});

describe("speak MCP tool", () => {
  const logger = createTestLogger();

  it("invokes registered speak handler for caller agent", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const speak = vi.fn().mockResolvedValue(undefined);
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "voice-agent-1",
      enableVoiceTools: true,
      resolveSpeakHandler: () => speak,
      logger,
    });
    const tool = registeredTool(server, "speak");
    expect(tool).toBeDefined();

    await tool.handler({ text: "Hello from voice agent." });
    expect(speak).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Hello from voice agent.",
        callerAgentId: "voice-agent-1",
      }),
    );
  });

  it("fails when no speak handler exists", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "voice-agent-2",
      enableVoiceTools: true,
      resolveSpeakHandler: () => null,
      logger,
    });
    const tool = registeredTool(server, "speak");
    await expect(tool.handler({ text: "Hello." })).rejects.toThrow(
      "No speak handler registered for your session",
    );
  });

  it("does not register speak tool unless voice tools are enabled", async () => {
    const { agentManager, agentStorage } = createTestDeps();
    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      callerAgentId: "agent-no-voice",
      logger,
    });
    const tool = lookupTool(server, "speak");
    expect(tool).toBeUndefined();
  });
});

describe("agent snapshot MCP serialization", () => {
  const logger = createTestLogger();

  it("returns compact list items from list_agents", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.listAgents = vi.fn().mockReturnValue([
      createManagedAgent({
        id: "agent-compact",
        provider: "codex",
        cwd: REPO_CWD,
        config: { model: "gpt-5.4", thinkingOptionId: "high" },
        runtimeInfo: { provider: "codex", sessionId: "session-123", model: "gpt-5.4" },
        labels: { role: "researcher" },
      }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });
    const tool = registeredTool(server, "list_agents");
    const response = await tool.handler({});
    const structured = z
      .object({ agents: z.array(z.record(z.string(), z.unknown())) })
      .parse(response.structuredContent);

    expect(structured).toEqual({
      agents: [
        {
          id: "agent-compact",
          shortId: "agent-c",
          title: null,
          provider: "codex",
          model: "gpt-5.4",
          thinkingOptionId: "high",
          effectiveThinkingOptionId: "high",
          status: "idle",
          cwd: REPO_CWD,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          lastUserMessageAt: null,
          archivedAt: null,
          requiresAttention: false,
          attentionReason: null,
          attentionTimestamp: null,
          labels: { role: "researcher" },
        },
      ],
    });
    expect(structured.agents[0]).not.toHaveProperty("features");
    expect(structured.agents[0]).not.toHaveProperty("availableModes");
    expect(structured.agents[0]).not.toHaveProperty("capabilities");
    expect(structured.agents[0]).not.toHaveProperty("runtimeInfo");
    expect(structured.agents[0]).not.toHaveProperty("persistence");
    expect(structured.agents[0]).not.toHaveProperty("pendingPermissions");
  });

  it("returns archived agent snapshots from storage for get_agent_status", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const record = createStoredRecord({
      id: "archived-agent",
      archivedAt: "2026-04-12T00:00:00.000Z",
    });
    spies.agentManager.getAgent.mockReturnValue(null);
    spies.agentStorage.get.mockResolvedValue(record);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerSnapshotManager: createClaudeOnlyManager(),
    });
    const tool = registeredTool(server, "get_agent_status");
    const response = await tool.handler({ agentId: "archived-agent" });

    expect(response.structuredContent).toEqual({
      status: "closed",
      snapshot: expect.objectContaining({
        id: "archived-agent",
        archivedAt: "2026-04-12T00:00:00.000Z",
        title: "Stored agent",
        status: "closed",
      }),
    });
    expect(spies.agentStorage.get).toHaveBeenCalledWith("archived-agent");
  });

  it("returns full-detail snapshots from get_agent_status", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentStorage.get.mockResolvedValue({ title: "Full detail agent" });
    spies.agentManager.getAgent.mockReturnValue(
      createManagedAgent({
        id: "full-detail-agent",
        provider: "codex",
        cwd: "/tmp/full-detail",
        config: { model: "gpt-5.4", thinkingOptionId: "high" },
        runtimeInfo: {
          provider: "codex",
          sessionId: "session-full",
          model: "gpt-5.4",
          thinkingOptionId: "xhigh",
          modeId: "auto",
        },
        currentModeId: "auto",
        availableModes: [
          {
            id: "auto",
            label: "Auto",
            description: "Default coding mode",
          },
        ],
        features: [
          {
            type: "toggle",
            id: "web-search",
            label: "Web search",
            value: true,
          },
        ],
        pendingPermissions: new Map(),
        persistence: {
          provider: "codex",
          sessionId: "session-full",
        },
        capabilities: {
          supportsStreaming: false,
          supportsSessionPersistence: false,
          supportsSessionListing: true,
          supportsDynamicModes: false,
          supportsMcpServers: true,
          supportsReasoningStream: false,
          supportsToolInvocations: true,
          supportsNewProviderCapability: true,
        },
      }),
    );

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });
    const tool = registeredTool(server, "get_agent_status");
    const response = await tool.handler({ agentId: "full-detail-agent" });
    const snapshot = z.record(z.string(), z.unknown()).parse(response.structuredContent.snapshot);

    const parsed = AgentSnapshotPayloadSchema.safeParse(snapshot);
    if (!parsed.success) {
      throw new Error(
        `get_agent_status response failed AgentSnapshotPayloadSchema: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
    expect(response.structuredContent.status).toBe("idle");
    expect(snapshot).toEqual(
      expect.objectContaining({
        id: "full-detail-agent",
        title: "Full detail agent",
        provider: "codex",
        model: "gpt-5.4",
        thinkingOptionId: "high",
        effectiveThinkingOptionId: "xhigh",
        currentModeId: "auto",
        runtimeInfo: {
          provider: "codex",
          sessionId: "session-full",
          model: "gpt-5.4",
          thinkingOptionId: "xhigh",
          modeId: "auto",
        },
        persistence: {
          provider: "codex",
          sessionId: "session-full",
        },
      }),
    );
    expect(snapshot.capabilities).toEqual(
      expect.objectContaining({
        supportsMcpServers: true,
        supportsToolInvocations: true,
      }),
    );
    expect(snapshot.availableModes).toEqual([
      {
        id: "auto",
        label: "Auto",
        description: "Default coding mode",
      },
    ]);
    expect(snapshot.features).toEqual([
      {
        type: "toggle",
        id: "web-search",
        label: "Web search",
        value: true,
      },
    ]);
    expect(snapshot.pendingPermissions).toEqual([]);
  });

  it("does not expose internal stored agents from get_agent_status", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.getAgent.mockReturnValue(null);
    spies.agentStorage.get.mockResolvedValue(
      createStoredRecord({
        id: "internal-agent",
        internal: true,
      }),
    );

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerSnapshotManager: createClaudeOnlyManager(),
    });
    const tool = registeredTool(server, "get_agent_status");

    await expect(tool.handler({ agentId: "internal-agent" })).rejects.toThrow(
      "Agent internal-agent not found",
    );
  });

  it("defaults list_agents to caller cwd and excludes archived agents", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const now = new Date().toISOString();
    spies.agentManager.getAgent.mockReturnValue(
      createManagedAgent({ id: "caller-agent", cwd: "/tmp/workspace" }),
    );
    spies.agentManager.listAgents.mockReturnValue([
      createManagedAgent({ id: "in-cwd", cwd: "/tmp/workspace" }),
      createManagedAgent({ id: "in-child-cwd", cwd: "/tmp/workspace/packages/server" }),
      createManagedAgent({ id: "other-cwd", cwd: "/tmp/other" }),
    ]);
    spies.agentStorage.list.mockResolvedValue([
      createStoredRecord({
        id: "stored-in-cwd",
        cwd: "/tmp/workspace",
        updatedAt: now,
        lastActivityAt: now,
        archivedAt: null,
      }),
      createStoredRecord({
        id: "archived-in-cwd",
        cwd: "/tmp/workspace",
        updatedAt: now,
        lastActivityAt: now,
        archivedAt: now,
      }),
      createStoredRecord({ id: "internal-agent", archivedAt: null, internal: true }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerSnapshotManager: createClaudeOnlyManager(),
      callerAgentId: "caller-agent",
    });
    const tool = registeredTool(server, "list_agents");
    const response = await tool.handler({});

    const agentIds = agentsOf(response).map((agent) => agent.id);
    expect(agentIds).toHaveLength(3);
    expect(new Set(agentIds)).toEqual(new Set(["in-cwd", "in-child-cwd", "stored-in-cwd"]));
  });

  it("allows explicit cwd, status, archive, time, and limit filters for list_agents", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const now = Date.now();
    const recent = new Date(now - 60 * 60 * 1000).toISOString();
    const old = new Date(now - 72 * 60 * 60 * 1000).toISOString();
    spies.agentManager.listAgents.mockReturnValue([
      createManagedAgent({
        id: "running-target",
        cwd: TARGET_CWD,
        lifecycle: "running",
        updatedAt: new Date(recent),
      }),
      createManagedAgent({
        id: "idle-target",
        cwd: TARGET_CWD,
        lifecycle: "idle",
        updatedAt: new Date(recent),
      }),
      createManagedAgent({
        id: "old-running-target",
        cwd: TARGET_CWD,
        lifecycle: "running",
        createdAt: new Date(old),
        updatedAt: new Date(old),
      }),
    ]);
    spies.agentStorage.list.mockResolvedValue([
      createStoredRecord({ id: "recent-archived", cwd: TARGET_CWD, archivedAt: recent }),
      createStoredRecord({ id: "old-archived", cwd: TARGET_CWD, archivedAt: old }),
      createStoredRecord({
        id: "recent-other-cwd",
        cwd: resolvePath("/tmp/other"),
        archivedAt: recent,
      }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerSnapshotManager: createClaudeOnlyManager(),
    });
    const tool = registeredTool(server, "list_agents");
    const response = await tool.handler({
      cwd: TARGET_CWD,
      includeArchived: true,
      sinceHours: 48,
      statuses: ["running", "closed"],
      limit: 3,
    });

    expect(agentsOf(response).map((agent) => agent.id)).toEqual([
      "running-target",
      "old-running-target",
      "recent-archived",
    ]);
  });

  it("bounds includeArchived by default time window and limit", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const now = Date.now();
    const recentArchivedRecords = Array.from({ length: 55 }, (_, index) =>
      createStoredRecord({
        id: `recent-archived-${index.toString().padStart(2, "0")}`,
        archivedAt: new Date(now - index * 60 * 1000).toISOString(),
      }),
    );
    spies.agentStorage.list.mockResolvedValue([
      ...recentArchivedRecords,
      createStoredRecord({
        id: "old-archived",
        archivedAt: new Date(now - 49 * 60 * 60 * 1000).toISOString(),
      }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerSnapshotManager: createClaudeOnlyManager(),
    });
    const tool = registeredTool(server, "list_agents");
    const response = await tool.handler({ includeArchived: true });
    const agentIds = agentsOf(response).map((agent) => agent.id);

    expect(agentIds).toHaveLength(50);
    expect(agentIds).toEqual(
      Array.from(
        { length: 50 },
        (_, index) => `recent-archived-${index.toString().padStart(2, "0")}`,
      ),
    );
    expect(agentIds).not.toContain("old-archived");
  });

  it("returns compact list items for stored archived agents", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const now = new Date().toISOString();
    spies.agentStorage.list.mockResolvedValue([
      createStoredRecord({
        id: "stored-archived-compact",
        cwd: REPO_CWD,
        updatedAt: now,
        lastActivityAt: now,
        archivedAt: now,
        features: [
          {
            type: "toggle",
            id: "danger-zone",
            label: "Danger zone",
            value: false,
          },
        ],
      }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerSnapshotManager: createClaudeOnlyManager(),
    });
    const tool = registeredTool(server, "list_agents");
    const response = await tool.handler({ cwd: REPO_CWD, includeArchived: true });
    const item = agentsOf(response)[0];

    expect(item).toEqual({
      id: "stored-archived-compact",
      shortId: "stored-",
      title: "Stored agent",
      provider: "claude",
      model: "claude-sonnet-4-20250514",
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      status: "closed",
      cwd: REPO_CWD,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: now,
      lastUserMessageAt: null,
      archivedAt: now,
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      labels: {},
    });
    expect(item).not.toHaveProperty("features");
    expect(item).not.toHaveProperty("availableModes");
    expect(item).not.toHaveProperty("capabilities");
    expect(item).not.toHaveProperty("runtimeInfo");
    expect(item).not.toHaveProperty("persistence");
    expect(item).not.toHaveProperty("pendingPermissions");
  });

  it("sorts list_agents by attention, status priority, then activity", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const now = Date.now();
    spies.agentManager.listAgents.mockReturnValue([
      createManagedAgent({
        id: "idle-recent",
        lifecycle: "idle",
        updatedAt: new Date(now),
      }),
      createManagedAgent({
        id: "running-older",
        lifecycle: "running",
        updatedAt: new Date(now - 60 * 60 * 1000),
      }),
      createManagedAgent({
        id: "closed-newest",
        lifecycle: "closed",
        updatedAt: new Date(now + 60 * 1000),
      }),
      createManagedAgent({
        id: "initializing-middle",
        lifecycle: "initializing",
        updatedAt: new Date(now - 30 * 60 * 1000),
      }),
      createManagedAgent({
        id: "idle-attention-oldest",
        lifecycle: "idle",
        updatedAt: new Date(now - 2 * 60 * 60 * 1000),
        attention: {
          requiresAttention: true,
          attentionReason: "permission",
          attentionTimestamp: new Date(now - 2 * 60 * 60 * 1000),
        },
      }),
      createManagedAgent({
        id: "error-recent",
        lifecycle: "error",
        updatedAt: new Date(now),
      }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      providerSnapshotManager: createOpenCodeManager().manager,
      logger,
    });
    const tool = registeredTool(server, "list_agents");
    const response = await tool.handler({});

    expect(agentsOf(response).map((agent) => agent.id)).toEqual([
      "idle-attention-oldest",
      "running-older",
      "initializing-middle",
      "idle-recent",
      "error-recent",
      "closed-newest",
    ]);
  });

  it("emits list_agents payloads that satisfy the agent list schema", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const now = new Date().toISOString();
    spies.agentManager.listAgents.mockReturnValue([createManagedAgent()]);
    spies.agentStorage.list.mockResolvedValue([
      createStoredRecord({
        id: "stored-non-archived",
        updatedAt: now,
        lastActivityAt: now,
        archivedAt: null,
      }),
      createStoredRecord({ id: "stored-archived", archivedAt: now }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerSnapshotManager: createClaudeOnlyManager(),
    });
    const tool = registeredTool(server, "list_agents");
    const response = await tool.handler({ includeArchived: true });

    const parsed = z.array(AgentListItemPayloadSchema).safeParse(response.structuredContent.agents);
    if (!parsed.success) {
      throw new Error(
        `list_agents response failed AgentListItemPayloadSchema: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
  });

  it("emits list_pending_permissions payloads that satisfy the permission schema", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    spies.agentManager.listAgents.mockReturnValue([
      createManagedAgent({
        id: "agent-with-permission",
        provider: "codex",
        pendingPermissions: new Map([
          [
            "perm-minimal",
            {
              id: "perm-minimal",
              provider: "codex",
              name: "request_user_input",
              kind: "question",
              title: "Need input",
              input: { prompt: "Pick one" },
              detail: undefined,
              metadata: { source: "test" },
            },
          ],
        ]),
      }),
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerSnapshotManager: createClaudeOnlyManager(),
    });
    const tool = registeredTool(server, "list_pending_permissions");
    const response = await tool.handler({});

    const permissions = z
      .array(
        z.object({
          agentId: z.string(),
          status: z.string(),
          request: AgentPermissionRequestPayloadSchema,
        }),
      )
      .parse(response.structuredContent.permissions);
    expect(permissions).toEqual([
      {
        agentId: "agent-with-permission",
        status: "idle",
        request: {
          id: "perm-minimal",
          provider: "codex",
          name: "request_user_input",
          kind: "question",
          title: "Need input",
          input: { prompt: "Pick one" },
          metadata: { source: "test" },
        },
      },
    ]);
  });

  it("loads archived agents before reading get_agent_activity", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const record = createStoredRecord({ id: "archived-activity-agent" });
    const snapshot = {
      id: "archived-activity-agent",
      currentModeId: "default",
    } as ManagedAgent;
    spies.agentManager.getAgent
      .mockReturnValueOnce(null)
      .mockReturnValue(snapshot)
      .mockReturnValue(snapshot);
    spies.agentStorage.get.mockResolvedValue(record);
    spies.agentManager.resumeAgentFromPersistence.mockResolvedValue(snapshot);
    spies.agentManager.getTimeline.mockReturnValue([
      {
        kind: "status",
        timestamp: "2026-04-11T00:00:00.000Z",
        text: "Agent resumed",
      },
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger,
      providerSnapshotManager: createClaudeOnlyManager(),
    });
    const tool = registeredTool(server, "get_agent_activity");
    const response = await tool.handler({ agentId: "archived-activity-agent" });

    expect(response.structuredContent).toEqual(
      expect.objectContaining({
        agentId: "archived-activity-agent",
        updateCount: 1,
        currentModeId: "default",
      }),
    );
    expect(spies.agentManager.resumeAgentFromPersistence).toHaveBeenCalled();
    expect(spies.agentManager.hydrateTimelineFromProvider).toHaveBeenCalledWith(
      "archived-activity-agent",
    );
  });

  it("get_agent_activity limit counts projected messages, not raw deltas", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const snapshot = createManagedAgent({ id: "live-activity-agent", currentModeId: "default" });
    spies.agentManager.getAgent.mockReturnValue(snapshot);
    spies.agentManager.getTimeline.mockReturnValue([
      { type: "user_message", text: "Say hi" },
      { type: "assistant_message", text: "Hello " },
      { type: "assistant_message", text: "world" },
      { type: "assistant_message", text: "." },
      { type: "assistant_message", text: " How" },
      { type: "assistant_message", text: " are" },
      { type: "assistant_message", text: " you?" },
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger: createTestLogger(),
      providerSnapshotManager: createClaudeOnlyManager(),
    });
    const tool = registeredTool(server, "get_agent_activity");
    const response = await tool.handler({ agentId: "live-activity-agent", limit: 1 });

    const content = String(response.structuredContent.content);
    expect(content).toContain("Hello world. How are you?");
  });

  it("get_agent_activity limit=2 returns the last two projected entries whole", async () => {
    const { agentManager, agentStorage, spies } = createTestDeps();
    const snapshot = createManagedAgent({ id: "live-activity-agent-2", currentModeId: "default" });
    spies.agentManager.getAgent.mockReturnValue(snapshot);
    spies.agentManager.getTimeline.mockReturnValue([
      { type: "user_message", text: "u1" },
      { type: "assistant_message", text: "first " },
      { type: "assistant_message", text: "answer" },
      { type: "user_message", text: "u2" },
      { type: "assistant_message", text: "second " },
      { type: "assistant_message", text: "answer" },
      { type: "user_message", text: "u3" },
      { type: "assistant_message", text: "third " },
      { type: "assistant_message", text: "answer" },
    ]);

    const server = await createAgentMcpServer({
      agentManager,
      agentStorage,
      logger: createTestLogger(),
      providerSnapshotManager: createClaudeOnlyManager(),
    });
    const tool = registeredTool(server, "get_agent_activity");
    const response = await tool.handler({ agentId: "live-activity-agent-2", limit: 2 });

    const content = String(response.structuredContent.content);
    expect(content).toContain("[User] u3");
    expect(content).toContain("third answer");
    expect(content).not.toContain("[User] u2");
    expect(content).not.toContain("second answer");
    expect(content).not.toContain("first answer");
  });
});
