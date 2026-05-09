import { execSync } from "child_process";
import { EventEmitter } from "events";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { WorkspaceDescriptorPayload } from "../shared/messages.js";
import { decodeFileTransferFrame, FileTransferOpcode } from "../shared/binary-frames/index.js";
import { Session } from "./session.js";
import { StructuredAgentFallbackError } from "./agent/agent-response-loop.js";
import type {
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  AgentTimelineItem,
  ListModesOptions,
  ListModelsOptions,
  PersistedAgentDescriptor,
} from "./agent/agent-sdk-types.js";
import type { ManagedAgent } from "./agent/agent-manager.js";
import type { ProviderDefinition } from "./agent/provider-registry.js";
import { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import type { SessionOptions } from "./session.js";
import type {
  SpeechToTextProvider,
  StreamingTranscriptionCommittedEvent,
  StreamingTranscriptionEvent,
  StreamingTranscriptionSession,
} from "./speech/speech-provider.js";
import type {
  TurnDetectionProvider,
  TurnDetectionSession,
} from "./speech/turn-detection-provider.js";
import {
  asSessionInternals as asSessionInternalsHelper,
  asAgentManager,
  asAgentStorage,
  asDownloadTokenStore,
  asPushTokenStore,
  asChatService,
  asScheduleService,
  asLoopService,
  asCheckoutDiffManager,
  asGitHubService,
  asWorkspaceGitService,
  asDaemonConfigStore,
  createProviderSnapshotManagerStub,
} from "./test-utils/session-stubs.js";
import { isPlatform } from "../test-utils/platform.js";

interface SessionHandlerInternals {
  startVoiceTurnController(): Promise<void>;
  stopVoiceTurnController(): Promise<void>;
  handleSendAgentMessage(
    agentId: string,
    text: string,
    messageId?: string,
    images?: Array<{ data: string; mimeType: string }>,
    attachments?: unknown[],
    runOptions?: unknown,
    options?: { spokenInput?: boolean },
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  handleCheckoutMergeRequest(params: unknown): Promise<unknown>;
  handleCheckoutMergeFromBaseRequest(params: unknown): Promise<unknown>;
  handleCheckoutCommitRequest(params: unknown): Promise<unknown>;
  handleCheckoutPrCreateRequest(params: unknown): Promise<unknown>;
  handleCheckoutPrMergeRequest(params: unknown): Promise<unknown>;
  handleCheckoutPullRequest(params: unknown): Promise<unknown>;
  handleCheckoutPushRequest(params: unknown): Promise<unknown>;
  handleCheckoutStatusRequest(params: unknown): Promise<unknown>;
  handleFetchRecentProviderSessions(params: unknown): Promise<unknown>;
  handleImportAgentRequest(params: unknown): Promise<unknown>;
  describeWorkspaceRecord(...args: unknown[]): Promise<WorkspaceDescriptorPayload>;
  describeWorkspaceRecordWithGitData(...args: unknown[]): Promise<WorkspaceDescriptorPayload>;
  handleValidateBranchRequest(params: unknown): Promise<unknown>;
  createBranchFromBase(params: unknown): Promise<unknown>;
  handleCheckoutSwitchBranchRequest(params: unknown): Promise<unknown>;
  handleBranchSuggestionsRequest(params: unknown): Promise<unknown>;
  handleStashListRequest(params: unknown): Promise<unknown>;
  handleStashSaveRequest(params: unknown): Promise<unknown>;
  handleStashPopRequest(params: unknown): Promise<unknown>;
  createPaseoWorktree(params: unknown): Promise<unknown>;
  handleStartWorkspaceScriptRequest(params: unknown): Promise<unknown>;
  getProviderRegistry(): unknown;
  sttManager: {
    transcribe(audio: Buffer, format: string): Promise<unknown>;
  };
}

function asSessionInternals(session: Session): SessionHandlerInternals {
  return asSessionInternalsHelper<SessionHandlerInternals>(session);
}

function createBinaryMessageHandler(
  binaryMessages: Uint8Array[] | undefined,
): ((frame: Uint8Array) => void) | undefined {
  if (!binaryMessages) {
    return undefined;
  }
  return (frame) => {
    binaryMessages.push(frame);
  };
}

const checkoutGitMocks = vi.hoisted(() => ({
  checkoutResolvedBranch: vi.fn(),
  commitChanges: vi.fn(),
  createPullRequest: vi.fn(),
  getCachedCheckoutShortstat: vi.fn(),
  getCheckoutStatus: vi.fn(),
  listBranchSuggestions: vi.fn(),
  mergeFromBase: vi.fn(),
  mergeToBase: vi.fn(),
  pullCurrentBranch: vi.fn(),
  pushCurrentBranch: vi.fn(),
  resolveBranchCheckout: vi.fn(),
  warmCheckoutShortstatInBackground: vi.fn(),
}));

const agentResponseMocks = vi.hoisted(() => ({
  generateStructuredAgentResponseWithFallback: vi.fn(),
}));

const agentMetadataMocks = vi.hoisted(() => ({
  scheduleAgentMetadataGeneration: vi.fn(),
}));

const spawnMocks = vi.hoisted(() => ({
  execCommand: vi.fn(),
  spawnWorkspaceScript: vi.fn(),
}));

const paseoWorktreeServiceMocks = vi.hoisted(() => ({
  createPaseoWorktree: vi.fn(),
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

const TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

function createTestProviderDefinition(overrides?: Partial<ProviderDefinition>): ProviderDefinition {
  return {
    id: "codex",
    label: "Codex",
    description: "Codex test provider",
    enabled: true,
    defaultModeId: null,
    modes: [],
    createClient: () =>
      ({
        provider: "codex",
        capabilities: TEST_CAPABILITIES,
        async createSession() {
          throw new Error("not implemented");
        },
        async resumeSession() {
          throw new Error("not implemented");
        },
        async listModels() {
          return [];
        },
        async isAvailable() {
          return true;
        },
      }) satisfies AgentClient,
    fetchModels: async () => [],
    fetchModes: async () => [],
    ...overrides,
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

vi.mock("../utils/checkout-git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/checkout-git.js")>();
  return {
    ...actual,
    checkoutResolvedBranch: checkoutGitMocks.checkoutResolvedBranch,
    commitChanges: checkoutGitMocks.commitChanges,
    createPullRequest: checkoutGitMocks.createPullRequest,
    getCachedCheckoutShortstat: checkoutGitMocks.getCachedCheckoutShortstat,
    getCheckoutStatus: checkoutGitMocks.getCheckoutStatus,
    listBranchSuggestions: checkoutGitMocks.listBranchSuggestions,
    mergeFromBase: checkoutGitMocks.mergeFromBase,
    mergeToBase: checkoutGitMocks.mergeToBase,
    pullCurrentBranch: checkoutGitMocks.pullCurrentBranch,
    pushCurrentBranch: checkoutGitMocks.pushCurrentBranch,
    resolveBranchCheckout: checkoutGitMocks.resolveBranchCheckout,
    warmCheckoutShortstatInBackground: checkoutGitMocks.warmCheckoutShortstatInBackground,
  };
});

vi.mock("./paseo-worktree-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paseo-worktree-service.js")>();
  return {
    ...actual,
    createPaseoWorktree: paseoWorktreeServiceMocks.createPaseoWorktree,
  };
});

vi.mock("../utils/spawn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/spawn.js")>();
  return {
    ...actual,
    execCommand: spawnMocks.execCommand,
  };
});

vi.mock("./agent/agent-response-loop.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent/agent-response-loop.js")>();
  return {
    ...actual,
    generateStructuredAgentResponseWithFallback:
      agentResponseMocks.generateStructuredAgentResponseWithFallback,
  };
});

vi.mock("./agent/agent-metadata-generator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent/agent-metadata-generator.js")>();
  return {
    ...actual,
    scheduleAgentMetadataGeneration: agentMetadataMocks.scheduleAgentMetadataGeneration,
  };
});

vi.mock("./worktree-bootstrap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./worktree-bootstrap.js")>();
  return {
    ...actual,
    spawnWorkspaceScript: spawnMocks.spawnWorkspaceScript,
  };
});

interface SessionForTestOptions {
  github?: {
    invalidate: ReturnType<typeof vi.fn>;
    isAuthenticated?: ReturnType<typeof vi.fn>;
    getPullRequestTimeline?: ReturnType<typeof vi.fn>;
    searchIssuesAndPrs?: ReturnType<typeof vi.fn>;
  };
  checkoutDiffManager?: { scheduleRefreshForCwd: ReturnType<typeof vi.fn> };
  workspaceGitService?: {
    getCheckoutDiff?: ReturnType<typeof vi.fn>;
    getSnapshot?: ReturnType<typeof vi.fn>;
    suggestBranchesForCwd?: ReturnType<typeof vi.fn>;
    listStashes?: ReturnType<typeof vi.fn>;
    peekSnapshot?: ReturnType<typeof vi.fn>;
    validateBranchRef?: ReturnType<typeof vi.fn>;
    hasLocalBranch?: ReturnType<typeof vi.fn>;
    resolveRepoRemoteUrl?: ReturnType<typeof vi.fn>;
    resolveRepoRoot?: ReturnType<typeof vi.fn>;
    getWorkspaceGitMetadata?: ReturnType<typeof vi.fn>;
  };
  workspaceRegistry?: { get: ReturnType<typeof vi.fn> };
  projectRegistry?: Partial<SessionOptions["projectRegistry"]>;
  terminalManager?: SessionOptions["terminalManager"];
  scriptRouteStore?: SessionOptions["scriptRouteStore"];
  scriptRuntimeStore?: SessionOptions["scriptRuntimeStore"];
  getDaemonTcpPort?: () => number | null;
  getDaemonTcpHost?: () => string | null;
  providerSnapshotManager?: ProviderSnapshotManager;
  stt?: SessionOptions["stt"];
  voice?: SessionOptions["voice"];
  messages?: unknown[];
  binaryMessages?: Uint8Array[];
}

function createSessionForTest(options: SessionForTestOptions = {}): Session {
  const logger = pino({ level: "silent" });
  const github = options.github ?? {
    invalidate: vi.fn(),
    searchIssuesAndPrs: vi.fn(),
    createPullRequest: vi.fn(),
    mergePullRequest: vi.fn(),
  };
  const checkoutDiffManager = options.checkoutDiffManager ?? {
    scheduleRefreshForCwd: vi.fn(),
  };
  const workspaceGitService = options.workspaceGitService ?? {
    getCheckoutDiff: vi.fn(),
    getSnapshot: vi.fn(),
    suggestBranchesForCwd: vi.fn(),
    listStashes: vi.fn(),
    peekSnapshot: vi.fn(),
    validateBranchRef: vi.fn(),
    hasLocalBranch: vi.fn(),
    resolveRepoRemoteUrl: vi.fn(),
    resolveRepoRoot: vi.fn(),
    getWorkspaceGitMetadata: vi.fn(),
  };
  const messages = options.messages ?? [];

  return new Session({
    clientId: "test-client",
    onMessage: (message) => messages.push(message),
    onBinaryMessage: createBinaryMessageHandler(options.binaryMessages),
    logger,
    downloadTokenStore: asDownloadTokenStore(),
    pushTokenStore: asPushTokenStore(),
    paseoHome: "/tmp/paseo-home",
    agentManager: asAgentManager({
      listAgents: vi.fn(() => []),
      subscribe: vi.fn(() => () => {}),
    }),
    agentStorage: asAgentStorage({
      list: vi.fn().mockResolvedValue([]),
    }),
    projectRegistry: options.projectRegistry ?? {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      upsert: vi.fn(),
      archive: vi.fn(),
      remove: vi.fn(),
      initialize: vi.fn(),
      existsOnDisk: vi.fn(),
    },
    workspaceRegistry: options.workspaceRegistry ?? {
      get: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
    },
    chatService: asChatService(),
    scheduleService: asScheduleService(),
    loopService: asLoopService(),
    checkoutDiffManager: asCheckoutDiffManager(checkoutDiffManager),
    github: asGitHubService(github),
    workspaceGitService: asWorkspaceGitService(workspaceGitService),
    daemonConfigStore: asDaemonConfigStore({
      get: vi.fn(() => ({
        mcp: { injectIntoAgents: false },
        providers: {},
      })),
      onChange: vi.fn(() => () => {}),
    }),
    stt: options.stt ?? null,
    tts: null,
    terminalManager: options.terminalManager ?? null,
    providerSnapshotManager: options.providerSnapshotManager,
    scriptRouteStore: options.scriptRouteStore,
    scriptRuntimeStore: options.scriptRuntimeStore,
    getDaemonTcpPort: options.getDaemonTcpPort,
    getDaemonTcpHost: options.getDaemonTcpHost,
    voice: options.voice,
  });
}

class FakeVoiceTurnDetectionSession extends EventEmitter implements TurnDetectionSession {
  public readonly requiredSampleRate = 16000;

  async connect(): Promise<void> {}

  appendPcm16(_chunk: Buffer): void {}

  flush(): void {}
  reset(): void {}
  close(): void {}
}

class FakeVoiceSttSession extends EventEmitter implements StreamingTranscriptionSession {
  public readonly requiredSampleRate = 16000;
  public commitCount = 0;

  async connect(): Promise<void> {}

  appendPcm16(_pcm16le: Buffer): void {}

  commit(): void {
    this.commitCount += 1;
  }

  clear(): void {}
  close(): void {}

  emitCommitted(event: StreamingTranscriptionCommittedEvent): void {
    this.emit("committed", event);
  }

  emitTranscript(event: StreamingTranscriptionEvent): void {
    this.emit("transcript", event);
  }
}

function createVoiceSessionHarness() {
  const messages: unknown[] = [];
  const detector = new FakeVoiceTurnDetectionSession();
  const sttSession = new FakeVoiceSttSession();
  const sttProvider: SpeechToTextProvider = {
    id: "local",
    createSession: vi.fn(() => sttSession),
  };
  const turnDetection: TurnDetectionProvider = {
    id: "local",
    createSession: vi.fn(() => detector),
  };
  const session = createSessionForTest({
    messages,
    stt: sttProvider,
    voice: { turnDetection },
  });
  Object.assign(session, {
    isVoiceMode: true,
    voiceModeAgentId: "11111111-1111-4111-8111-111111111111",
  });
  const internals = asSessionInternals(session);
  const sendAgentMessage = vi
    .spyOn(internals, "handleSendAgentMessage")
    .mockResolvedValue({ ok: true });
  const transcribe = vi.spyOn(asSessionInternals(session).sttManager, "transcribe");

  return {
    session,
    internals,
    messages,
    detector,
    sttSession,
    sendAgentMessage,
    transcribe,
  };
}

async function settleVoiceSession(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("session voice mode streaming transcription", () => {
  test("submits the streaming final transcript to the agent without batch transcribe", async () => {
    const harness = createVoiceSessionHarness();

    await harness.internals.startVoiceTurnController();
    harness.detector.emit("speech_started");
    await settleVoiceSession();
    harness.detector.emit("speech_stopped");
    await settleVoiceSession();
    harness.sttSession.emitCommitted({ segmentId: "segment-1", previousSegmentId: null });
    harness.sttSession.emitTranscript({
      segmentId: "segment-1",
      transcript: "ship the streaming final",
      isFinal: true,
      language: "en",
      avgLogprob: -0.1,
      isLowConfidence: false,
    });
    await settleVoiceSession();

    expect(harness.sttSession.commitCount).toBe(1);
    expect(harness.transcribe).not.toHaveBeenCalled();
    expect(harness.sendAgentMessage).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "ship the streaming final",
      undefined,
      undefined,
      undefined,
      undefined,
      { spokenInput: true },
    );
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "transcription_result",
        payload: expect.objectContaining({
          text: "ship the streaming final",
          language: "en",
          avgLogprob: -0.1,
        }),
      }),
    );

    await harness.internals.stopVoiceTurnController();
  });

  test("uses the finalization timeout empty transcript path without agent submission", async () => {
    vi.useFakeTimers();
    try {
      const harness = createVoiceSessionHarness();

      await harness.internals.startVoiceTurnController();
      harness.detector.emit("speech_started");
      await settleVoiceSession();
      harness.detector.emit("speech_stopped");
      await settleVoiceSession();
      harness.sttSession.emitCommitted({ segmentId: "segment-1", previousSegmentId: null });

      await vi.advanceTimersByTimeAsync(10_000);
      await settleVoiceSession();

      expect(harness.transcribe).not.toHaveBeenCalled();
      expect(harness.sendAgentMessage).not.toHaveBeenCalled();
      expect(harness.messages).toContainEqual(
        expect.objectContaining({
          type: "transcription_result",
          payload: expect.objectContaining({
            text: "",
          }),
        }),
      );

      await harness.internals.stopVoiceTurnController();
    } finally {
      vi.useRealTimers();
    }
  });

  test("filters low-confidence streaming finals without agent submission", async () => {
    const harness = createVoiceSessionHarness();

    await harness.internals.startVoiceTurnController();
    harness.detector.emit("speech_started");
    await settleVoiceSession();
    harness.detector.emit("speech_stopped");
    await settleVoiceSession();
    harness.sttSession.emitCommitted({ segmentId: "segment-1", previousSegmentId: null });
    harness.sttSession.emitTranscript({
      segmentId: "segment-1",
      transcript: "background noise",
      isFinal: true,
      avgLogprob: -2.5,
      isLowConfidence: true,
    });
    await settleVoiceSession();

    expect(harness.transcribe).not.toHaveBeenCalled();
    expect(harness.sendAgentMessage).not.toHaveBeenCalled();
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: "transcription_result",
        payload: expect.objectContaining({
          text: "",
          avgLogprob: -2.5,
          isLowConfidence: true,
        }),
      }),
    );

    await harness.internals.stopVoiceTurnController();
  });
});

describe("file explorer binary responses", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "file-explorer-session-test-")));
    tempDirs.push(root);
    return root;
  }

  test("old clients get legacy JSON file content from a new daemon", async () => {
    const cwd = makeRoot();
    writeFileSync(join(cwd, "logo.png"), "hello");
    const messages: unknown[] = [];
    const binaryMessages: Uint8Array[] = [];
    const session = createSessionForTest({ messages, binaryMessages });

    await session.handleMessage({
      type: "file_explorer_request",
      cwd,
      path: "logo.png",
      mode: "file",
      requestId: "req-old-client",
    });

    expect(binaryMessages).toEqual([]);
    expect(messages).toEqual([
      {
        type: "file_explorer_response",
        payload: expect.objectContaining({
          cwd,
          path: "logo.png",
          mode: "file",
          directory: null,
          error: null,
          requestId: "req-old-client",
          file: expect.objectContaining({
            kind: "image",
            encoding: "base64",
            content: "aGVsbG8=",
            mimeType: "image/png",
            size: 5,
          }),
        }),
      },
    ]);
  });

  test("new clients get binary file frames without legacy JSON content", async () => {
    const cwd = makeRoot();
    writeFileSync(join(cwd, "logo.png"), "hello");
    const messages: unknown[] = [];
    const binaryMessages: Uint8Array[] = [];
    const session = createSessionForTest({ messages, binaryMessages });

    await session.handleMessage({
      type: "file_explorer_request",
      cwd,
      path: "logo.png",
      mode: "file",
      requestId: "req-new-client",
      acceptBinary: true,
    });

    expect(messages).toEqual([]);
    expect(binaryMessages).toHaveLength(3);

    const frames = binaryMessages.map((frame) => decodeFileTransferFrame(frame));
    expect(frames[0]).toEqual({
      opcode: FileTransferOpcode.FileBegin,
      requestId: "req-new-client",
      metadata: {
        mime: "image/png",
        size: 5,
        encoding: "binary",
        modifiedAt: expect.any(String),
      },
      payload: new Uint8Array(),
    });
    expect(frames[1]).toEqual({
      opcode: FileTransferOpcode.FileChunk,
      requestId: "req-new-client",
      payload: new TextEncoder().encode("hello"),
    });
    expect(frames[2]).toEqual({
      opcode: FileTransferOpcode.FileEnd,
      requestId: "req-new-client",
      payload: new Uint8Array(),
    });
  });
});

function createProjectRecord(rootPath: string, archivedAt: string | null = null) {
  return {
    projectId: `project:${rootPath}`,
    rootPath,
    kind: "git" as const,
    displayName: "Project",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt,
  };
}

describe("project config RPC authorization", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "project-config-session-test-")));
    tempDirs.push(root);
    return root;
  }

  test("read_project_config_request accepts the same root with a trailing slash", async () => {
    const repoRoot = makeRoot();
    writeFileSync(join(repoRoot, "paseo.json"), JSON.stringify({ worktree: { setup: "npm ci" } }));
    const messages: unknown[] = [];
    const session = createSessionForTest({
      messages,
      projectRegistry: { list: vi.fn().mockResolvedValue([createProjectRecord(repoRoot)]) },
    });

    await session.handleMessage({
      type: "read_project_config_request",
      requestId: "read-trailing-slash-1",
      repoRoot: `${repoRoot}/`,
    });

    expect(messages).toEqual([
      {
        type: "read_project_config_response",
        payload: {
          requestId: "read-trailing-slash-1",
          repoRoot,
          ok: true,
          config: { worktree: { setup: "npm ci" } },
          revision: expect.objectContaining({
            mtimeMs: expect.any(Number),
            size: expect.any(Number),
          }),
        },
      },
    ]);
  });

  // POSIX-only: creates a directory symlink without Windows privileges.
  test.skipIf(isPlatform("win32"))(
    "read_project_config_request accepts a symlink to an active project root",
    async () => {
      const repoRoot = makeRoot();
      writeFileSync(
        join(repoRoot, "paseo.json"),
        JSON.stringify({ worktree: { setup: "npm ci" } }),
      );
      const linkRoot = join(makeRoot(), "link");
      symlinkSync(repoRoot, linkRoot, "dir");
      const messages: unknown[] = [];
      const session = createSessionForTest({
        messages,
        projectRegistry: { list: vi.fn().mockResolvedValue([createProjectRecord(repoRoot)]) },
      });

      await session.handleMessage({
        type: "read_project_config_request",
        requestId: "read-symlink-1",
        repoRoot: linkRoot,
      });

      expect(messages).toEqual([
        {
          type: "read_project_config_response",
          payload: {
            requestId: "read-symlink-1",
            repoRoot,
            ok: true,
            config: { worktree: { setup: "npm ci" } },
            revision: expect.objectContaining({
              mtimeMs: expect.any(Number),
              size: expect.any(Number),
            }),
          },
        },
      ]);
    },
  );

  test("read_project_config_request rejects archived and unknown roots with project_not_found", async () => {
    const archivedRoot = makeRoot();
    const unknownRoot = makeRoot();
    const messages: unknown[] = [];
    const session = createSessionForTest({
      messages,
      projectRegistry: {
        list: vi
          .fn()
          .mockResolvedValue([createProjectRecord(archivedRoot, "2026-01-02T00:00:00.000Z")]),
      },
    });

    await session.handleMessage({
      type: "read_project_config_request",
      requestId: "archived-1",
      repoRoot: archivedRoot,
    });
    await session.handleMessage({
      type: "read_project_config_request",
      requestId: "unknown-1",
      repoRoot: unknownRoot,
    });

    expect(messages).toEqual([
      {
        type: "read_project_config_response",
        payload: {
          requestId: "archived-1",
          repoRoot: archivedRoot,
          ok: false,
          error: { code: "project_not_found" },
        },
      },
      {
        type: "read_project_config_response",
        payload: {
          requestId: "unknown-1",
          repoRoot: unknownRoot,
          ok: false,
          error: { code: "project_not_found" },
        },
      },
    ]);
  });

  test("read_project_config_request emits raw lifecycle forms for a known project root", async () => {
    const repoRoot = makeRoot();
    writeFileSync(
      join(repoRoot, "paseo.json"),
      JSON.stringify({ worktree: { setup: "npm install", teardown: ["npm run clean"] } }),
    );
    const messages: unknown[] = [];
    const session = createSessionForTest({
      messages,
      projectRegistry: { list: vi.fn().mockResolvedValue([createProjectRecord(repoRoot)]) },
    });

    await session.handleMessage({
      type: "read_project_config_request",
      requestId: "read-1",
      repoRoot,
    });

    expect(messages).toEqual([
      {
        type: "read_project_config_response",
        payload: {
          requestId: "read-1",
          repoRoot,
          ok: true,
          config: { worktree: { setup: "npm install", teardown: ["npm run clean"] } },
          revision: expect.objectContaining({
            mtimeMs: expect.any(Number),
            size: expect.any(Number),
          }),
        },
      },
    ]);
  });

  test("write_project_config_request emits stale and write-failed inline domain failures", async () => {
    const staleRoot = makeRoot();
    writeFileSync(join(staleRoot, "paseo.json"), JSON.stringify({ worktree: { setup: "old" } }));
    const writeFailedRoot = join(makeRoot(), "not-a-directory");
    writeFileSync(writeFailedRoot, "file");
    const messages: unknown[] = [];
    const session = createSessionForTest({
      messages,
      projectRegistry: {
        list: vi
          .fn()
          .mockResolvedValue([
            createProjectRecord(staleRoot),
            createProjectRecord(writeFailedRoot),
          ]),
      },
    });

    await session.handleMessage({
      type: "write_project_config_request",
      requestId: "stale-1",
      repoRoot: staleRoot,
      config: { worktree: { setup: "new" } },
      expectedRevision: { mtimeMs: 1, size: 1 },
    });
    await session.handleMessage({
      type: "write_project_config_request",
      requestId: "write-failed-1",
      repoRoot: writeFailedRoot,
      config: { worktree: { setup: "new" } },
      expectedRevision: null,
    });

    expect(messages).toEqual([
      {
        type: "write_project_config_response",
        payload: {
          requestId: "stale-1",
          repoRoot: staleRoot,
          ok: false,
          error: {
            code: "stale_project_config",
            currentRevision: expect.objectContaining({
              mtimeMs: expect.any(Number),
              size: expect.any(Number),
            }),
          },
        },
      },
      {
        type: "write_project_config_response",
        payload: {
          requestId: "write-failed-1",
          repoRoot: writeFailedRoot,
          ok: false,
          error: { code: "write_failed" },
        },
      },
    ]);
  });
});

function createWorkspaceGitSnapshot(
  cwd: string,
  overrides?: {
    git?: Record<string, unknown>;
    github?: Record<string, unknown>;
  },
) {
  return {
    cwd,
    git: {
      isGit: true,
      repoRoot: cwd,
      mainRepoRoot: null,
      currentBranch: "feature/service",
      remoteUrl: "https://github.com/getpaseo/paseo.git",
      isPaseoOwnedWorktree: false,
      isDirty: true,
      baseRef: "main",
      aheadBehind: { ahead: 2, behind: 1 },
      aheadOfOrigin: 2,
      behindOfOrigin: 1,
      hasRemote: true,
      diffStat: { additions: 3, deletions: 1 },
      ...overrides?.git,
    },
    github: {
      featuresEnabled: false,
      pullRequest: null,
      error: null,
      ...overrides?.github,
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("session agent import", () => {
  test("filters already imported provider sessions by native handle", async () => {
    const messages: unknown[] = [];
    const cwd = "/tmp/import-filter";
    const importedDescriptor: PersistedAgentDescriptor = {
      provider: "claude",
      sessionId: "provider-session-imported",
      cwd,
      title: "Already imported",
      lastActivityAt: new Date("2026-04-30T12:00:00.000Z"),
      persistence: {
        provider: "claude",
        sessionId: "provider-session-imported",
        nativeHandle: "provider-native-imported",
      },
      timeline: [{ type: "user_message", text: "already imported" }],
    };
    const visibleDescriptor: PersistedAgentDescriptor = {
      provider: "claude",
      sessionId: "provider-session-visible",
      cwd,
      title: "Still importable",
      lastActivityAt: new Date("2026-04-30T11:00:00.000Z"),
      persistence: {
        provider: "claude",
        sessionId: "provider-session-visible",
        nativeHandle: "provider-native-visible",
      },
      timeline: [{ type: "user_message", text: "still importable" }],
    };
    const agentManager = {
      listAgents: vi.fn(() => [
        {
          provider: "claude",
          persistence: {
            provider: "claude",
            sessionId: "stored-session-id",
            nativeHandle: "provider-native-imported",
          },
        } as ManagedAgent,
      ]),
      listImportablePersistedAgents: vi
        .fn()
        .mockResolvedValue([importedDescriptor, visibleDescriptor]),
      subscribe: vi.fn(() => () => {}),
    };
    const agentStorage = {
      list: vi.fn().mockResolvedValue([]),
    };
    const session = createSessionForTest({ messages });
    Object.assign(session, { agentManager, agentStorage });

    await asSessionInternals(session).handleFetchRecentProviderSessions({
      type: "fetch_recent_provider_sessions_request",
      requestId: "recent-provider-sessions",
      cwd,
      providers: ["claude"],
      limit: 15,
    });

    expect(agentManager.listImportablePersistedAgents).toHaveBeenCalledWith({
      limit: 200,
      providerFilter: new Set(["claude"]),
      cwd,
    });
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "fetch_recent_provider_sessions_response",
        payload: expect.objectContaining({
          requestId: "recent-provider-sessions",
          filteredAlreadyImportedCount: 1,
          entries: [
            expect.objectContaining({
              providerId: "claude",
              providerHandleId: "provider-native-visible",
              title: "Still importable",
            }),
          ],
        }),
      }),
    );
  });

  test("imports by provider handle id and hydrates title metadata from the first user message", async () => {
    const messages: unknown[] = [];
    const cwd = "/tmp/imported-agent";
    const timeline: AgentTimelineItem[] = [
      { type: "user_message", text: "Trace recent provider sessions\n\nkeep it tight" },
      { type: "assistant_message", text: "I will inspect the provider listing." },
    ];
    const snapshot = {
      id: "00000000-0000-4000-8000-000000000633",
      provider: "custom-codex",
      cwd,
      capabilities: TEST_CAPABILITIES,
      config: { provider: "custom-codex", cwd },
      createdAt: new Date("2026-04-30T00:00:00.000Z"),
      updatedAt: new Date("2026-04-30T00:00:00.000Z"),
      availableModes: [],
      currentModeId: null,
      pendingPermissions: new Map(),
      bufferedPermissionResolutions: new Map(),
      inFlightPermissionResponses: new Set(),
      pendingReplacement: false,
      persistence: {
        provider: "custom-codex",
        sessionId: "thread-imported",
        nativeHandle: "provider-thread-imported",
        metadata: { provider: "custom-codex", cwd },
      },
      historyPrimed: true,
      lastUserMessageAt: null,
      attention: { requiresAttention: false },
      foregroundTurnWaiters: new Set(),
      finalizedForegroundTurnIds: new Set(),
      unsubscribeSession: null,
      internal: false,
      labels: {},
      lifecycle: "closed",
      session: null,
      activeForegroundTurnId: null,
    } satisfies ManagedAgent;
    const agentManager = {
      listAgents: vi.fn(() => []),
      subscribe: vi.fn(() => () => {}),
      findPersistedAgent: vi.fn().mockResolvedValue({
        provider: "custom-codex",
        sessionId: "thread-imported",
        cwd,
        title: null,
        firstPromptPreview: "Trace recent provider sessions",
        lastPromptPreview: "Trace recent provider sessions",
        lastActivityAt: new Date("2026-04-30T00:00:00.000Z"),
        persistence: snapshot.persistence,
      }),
      resumeAgentFromPersistence: vi.fn().mockResolvedValue(snapshot),
      hydrateTimelineFromProvider: vi.fn().mockResolvedValue(undefined),
      getTimeline: vi.fn().mockReturnValue(timeline),
      setTitle: vi.fn().mockResolvedValue(undefined),
      notifyAgentState: vi.fn(),
    };
    const agentStorage = {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
    };
    const session = createSessionForTest({ messages });
    Object.assign(session, { agentManager, agentStorage });

    await asSessionInternals(session).handleImportAgentRequest({
      type: "import_agent_request",
      providerId: "custom-codex",
      providerHandleId: "provider-thread-imported",
      cwd,
      requestId: "import-thread",
    });

    expect(agentManager.findPersistedAgent).toHaveBeenCalledWith(
      "custom-codex",
      "provider-thread-imported",
    );
    expect(agentManager.hydrateTimelineFromProvider).toHaveBeenCalledWith(snapshot.id);
    expect(agentManager.setTitle).toHaveBeenCalledWith(
      snapshot.id,
      "Trace recent provider sessions",
    );
    expect(agentMetadataMocks.scheduleAgentMetadataGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        agentManager,
        agentId: snapshot.id,
        cwd,
        initialPrompt: "Trace recent provider sessions\n\nkeep it tight",
        explicitTitle: null,
      }),
    );
  });

  test("sets a provisional title and schedules auto-title generation from the first hydrated user message", async () => {
    const messages: unknown[] = [];
    const cwd = "/tmp/imported-agent";
    const timeline: AgentTimelineItem[] = [
      { type: "user_message", text: "Investigate flaky checkout status\n\ninclude logs" },
      { type: "assistant_message", text: "I will inspect the checkout flow." },
    ];
    const snapshot = {
      id: "00000000-0000-4000-8000-000000000632",
      provider: "codex",
      cwd,
      capabilities: TEST_CAPABILITIES,
      config: { provider: "codex", cwd },
      createdAt: new Date("2026-04-30T00:00:00.000Z"),
      updatedAt: new Date("2026-04-30T00:00:00.000Z"),
      availableModes: [],
      currentModeId: null,
      pendingPermissions: new Map(),
      bufferedPermissionResolutions: new Map(),
      inFlightPermissionResponses: new Set(),
      pendingReplacement: false,
      persistence: {
        provider: "codex",
        sessionId: "thread-imported",
        nativeHandle: "thread-imported",
        metadata: { provider: "codex", cwd },
      },
      historyPrimed: true,
      lastUserMessageAt: null,
      attention: { requiresAttention: false },
      foregroundTurnWaiters: new Set(),
      finalizedForegroundTurnIds: new Set(),
      unsubscribeSession: null,
      internal: false,
      labels: {},
      lifecycle: "closed",
      session: null,
      activeForegroundTurnId: null,
    } satisfies ManagedAgent;
    const agentManager = {
      listAgents: vi.fn(() => []),
      subscribe: vi.fn(() => () => {}),
      findPersistedAgent: vi.fn().mockResolvedValue(null),
      resumeAgentFromPersistence: vi.fn().mockResolvedValue(snapshot),
      hydrateTimelineFromProvider: vi.fn().mockResolvedValue(undefined),
      getTimeline: vi.fn().mockReturnValue(timeline),
      setTitle: vi.fn().mockResolvedValue(undefined),
      notifyAgentState: vi.fn(),
    };
    const agentStorage = {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
    };
    const session = createSessionForTest({ messages });
    Object.assign(session, { agentManager, agentStorage });

    await asSessionInternals(session).handleImportAgentRequest({
      type: "import_agent_request",
      provider: "codex",
      sessionId: "thread-imported",
      cwd,
      requestId: "import-thread",
    });

    expect(agentManager.setTitle).toHaveBeenCalledWith(
      snapshot.id,
      "Investigate flaky checkout status",
    );
    expect(agentMetadataMocks.scheduleAgentMetadataGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        agentManager,
        agentId: snapshot.id,
        cwd,
        initialPrompt: "Investigate flaky checkout status\n\ninclude logs",
        explicitTitle: null,
      }),
    );
  });
});

describe("session provider refresh cwd routing", () => {
  test("routes no-cwd provider snapshot refreshes through settings refresh", async () => {
    const {
      manager: providerSnapshotManager,
      refreshSettingsSnapshot,
      refreshSnapshotForCwd,
    } = createProviderSnapshotManagerStub();
    const session = createSessionForTest({ providerSnapshotManager });

    await session.handleMessage({
      type: "refresh_providers_snapshot_request",
      providers: ["codex"],
      requestId: "refresh-settings",
    });

    expect(refreshSettingsSnapshot).toHaveBeenCalledWith({
      providers: ["codex"],
    });
    expect(refreshSnapshotForCwd).not.toHaveBeenCalled();
  });

  test("routes cwd provider snapshot refreshes through workspace refresh", async () => {
    const {
      manager: providerSnapshotManager,
      refreshSnapshotForCwd,
      refreshSettingsSnapshot,
    } = createProviderSnapshotManagerStub();
    const session = createSessionForTest({ providerSnapshotManager });

    await session.handleMessage({
      type: "refresh_providers_snapshot_request",
      cwd: "/tmp/workspace-refresh",
      providers: ["codex"],
      requestId: "refresh-workspace",
    });

    expect(refreshSnapshotForCwd).toHaveBeenCalledWith({
      cwd: "/tmp/workspace-refresh",
      providers: ["codex"],
    });
    expect(refreshSettingsSnapshot).not.toHaveBeenCalled();
  });

  test("normalizes legacy model and mode list requests without cwd to home", async () => {
    const messages: unknown[] = [];
    const session = createSessionForTest({ messages });
    const fetchModels = vi.fn(async () => []);
    const fetchModes = vi.fn(async () => []);
    asSessionInternals(session).getProviderRegistry = () => ({
      codex: createTestProviderDefinition({
        fetchModels,
        fetchModes,
      }),
    });

    await session.handleMessage({
      type: "list_provider_models_request",
      provider: "codex",
      requestId: "models-home",
    });
    await session.handleMessage({
      type: "list_provider_modes_request",
      provider: "codex",
      requestId: "modes-home",
    });

    expect(fetchModels).toHaveBeenCalledWith({ cwd: homedir(), force: false });
    expect(fetchModes).toHaveBeenCalledWith({ cwd: homedir(), force: false });
  });

  test("legacy model list request treats disabled snapshot entries as unavailable without warming", async () => {
    const messages: unknown[] = [];
    const { manager: providerSnapshotManager, warmUpSnapshotForCwd } =
      createProviderSnapshotManagerStub();
    providerSnapshotManager.getSnapshot = vi.fn(() => [
      {
        provider: "codex",
        status: "loading",
        enabled: false,
      },
    ]);
    const session = createSessionForTest({ messages, providerSnapshotManager });

    await session.handleMessage({
      type: "list_provider_models_request",
      provider: "codex",
      requestId: "models-disabled",
    });

    expect(warmUpSnapshotForCwd).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "list_provider_models_response",
      payload: {
        provider: "codex",
        error: "Provider codex is disabled",
        fetchedAt: expect.any(String),
        requestId: "models-disabled",
      },
    });
  });

  test("legacy mode list request treats disabled snapshot entries as unavailable without warming", async () => {
    const messages: unknown[] = [];
    const { manager: providerSnapshotManager, warmUpSnapshotForCwd } =
      createProviderSnapshotManagerStub();
    providerSnapshotManager.getSnapshot = vi.fn(() => [
      {
        provider: "codex",
        status: "loading",
        enabled: false,
      },
    ]);
    const session = createSessionForTest({ messages, providerSnapshotManager });

    await session.handleMessage({
      type: "list_provider_modes_request",
      provider: "codex",
      requestId: "modes-disabled",
    });

    expect(warmUpSnapshotForCwd).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "list_provider_modes_response",
      payload: {
        provider: "codex",
        error: "Provider codex is disabled",
        fetchedAt: expect.any(String),
        requestId: "modes-disabled",
      },
    });
  });

  test("legacy model and mode list fallback treats disabled registry definitions as unavailable without fetching", async () => {
    const messages: unknown[] = [];
    const session = createSessionForTest({ messages });
    const fetchModels = vi.fn(async () => [
      {
        provider: "codex" as const,
        id: "should-not-fetch",
        label: "Should not fetch",
      },
    ]);
    const fetchModes = vi.fn(async () => [
      {
        id: "should-not-fetch",
        label: "Should not fetch",
      },
    ]);
    asSessionInternals(session).getProviderRegistry = () => ({
      codex: createTestProviderDefinition({
        enabled: false,
        fetchModels,
        fetchModes,
      }),
    });

    await session.handleMessage({
      type: "list_provider_models_request",
      provider: "codex",
      requestId: "fallback-models-disabled",
    });
    await session.handleMessage({
      type: "list_provider_modes_request",
      provider: "codex",
      requestId: "fallback-modes-disabled",
    });

    expect(fetchModels).not.toHaveBeenCalled();
    expect(fetchModes).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "list_provider_models_response",
      payload: {
        provider: "codex",
        error: "Provider codex is disabled",
        fetchedAt: expect.any(String),
        requestId: "fallback-models-disabled",
      },
    });
    expect(messages).toContainEqual({
      type: "list_provider_modes_response",
      payload: {
        provider: "codex",
        error: "Provider codex is disabled",
        fetchedAt: expect.any(String),
        requestId: "fallback-modes-disabled",
      },
    });
  });

  test("legacy model list request without cwd awaits loading snapshot without forced discovery", async () => {
    const messages: unknown[] = [];
    const models = deferred<AgentModelDefinition[]>();
    const fetchModels = vi.fn(
      async (options: ListModelsOptions): Promise<AgentModelDefinition[]> => {
        expect(options.cwd).toBe(homedir());
        return models.promise;
      },
    );
    const fetchModes = vi.fn(async (_options: ListModesOptions): Promise<AgentMode[]> => []);
    const providerDefinition = createTestProviderDefinition({
      createClient: () =>
        ({
          provider: "codex",
          capabilities: TEST_CAPABILITIES,
          async createSession() {
            throw new Error("not implemented");
          },
          async resumeSession() {
            throw new Error("not implemented");
          },
          async listModels(options: ListModelsOptions) {
            return fetchModels(options);
          },
          async isAvailable() {
            return true;
          },
        }) satisfies AgentClient,
      fetchModels,
      fetchModes,
    });
    const providerSnapshotManager = new ProviderSnapshotManager(
      { codex: providerDefinition },
      pino({ level: "silent" }),
    );
    const session = createSessionForTest({ messages, providerSnapshotManager });

    providerSnapshotManager.getSnapshot();
    await vi.waitFor(() => {
      expect(fetchModels).toHaveBeenCalledTimes(1);
    });

    const responsePromise = session.handleMessage({
      type: "list_provider_models_request",
      provider: "codex",
      requestId: "models-loading-home",
    });

    await Promise.resolve();

    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(fetchModels).toHaveBeenCalledWith({ cwd: homedir(), force: false });
    expect(fetchModels).not.toHaveBeenCalledWith({ cwd: homedir(), force: true });

    models.resolve([
      {
        provider: "codex",
        id: "gpt-5.4",
        label: "GPT-5.4",
      },
    ]);
    await responsePromise;

    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(fetchModels).not.toHaveBeenCalledWith({ cwd: homedir(), force: true });
    expect(messages).toContainEqual({
      type: "list_provider_models_response",
      payload: {
        provider: "codex",
        models: [
          {
            provider: "codex",
            id: "gpt-5.4",
            label: "GPT-5.4",
          },
        ],
        error: null,
        fetchedAt: expect.any(String),
        requestId: "models-loading-home",
      },
    });

    providerSnapshotManager.destroy();
  });
});

describe("session checkout merge handling", () => {
  test("uses workspace git service snapshot for merge-to-base preflight", async () => {
    const messages: unknown[] = [];
    const github = { invalidate: vi.fn() };
    const checkoutDiffManager = { scheduleRefreshForCwd: vi.fn() };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue(
        createWorkspaceGitSnapshot("/tmp/request-worktree", {
          git: {
            isGit: true,
            baseRef: "main",
            isDirty: false,
          },
        }),
      ),
    };
    const session = createSessionForTest({
      github,
      checkoutDiffManager,
      workspaceGitService,
      messages,
    });

    checkoutGitMocks.mergeToBase.mockResolvedValue("/tmp/base-worktree");

    await asSessionInternals(session).handleCheckoutMergeRequest({
      type: "checkout_merge_request",
      cwd: "/tmp/request-worktree",
      baseRef: "main",
      requestId: "request-1",
    });

    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/request-worktree");
    expect(checkoutGitMocks.getCheckoutStatus).not.toHaveBeenCalled();
    expect(checkoutGitMocks.mergeToBase).toHaveBeenCalledWith(
      "/tmp/request-worktree",
      {
        baseRef: "main",
        mode: "merge",
      },
      { paseoHome: "/tmp/paseo-home" },
    );
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/base-worktree", {
      force: true,
      reason: "merge-to-base",
    });
    expect(github.invalidate).toHaveBeenCalledTimes(1);
    expect(github.invalidate).toHaveBeenCalledWith({ cwd: "/tmp/base-worktree" });
    expect(checkoutDiffManager.scheduleRefreshForCwd).toHaveBeenCalledWith("/tmp/request-worktree");
    expect(messages).toContainEqual({
      type: "checkout_merge_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: true,
        error: null,
        requestId: "request-1",
      },
    });
  });

  test("uses snapshot dirty state for merge-from-base clean target preflight", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue(
        createWorkspaceGitSnapshot("/tmp/request-worktree", {
          git: {
            isDirty: true,
          },
        }),
      ),
    };
    const session = createSessionForTest({ workspaceGitService, messages });

    await asSessionInternals(session).handleCheckoutMergeFromBaseRequest({
      type: "checkout_merge_from_base_request",
      cwd: "/tmp/request-worktree",
      baseRef: "main",
      requireCleanTarget: true,
      requestId: "request-merge-from-base",
    });

    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/request-worktree");
    expect(messages).toContainEqual({
      type: "checkout_merge_from_base_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: false,
        error: {
          code: "UNKNOWN",
          message: "Working directory has uncommitted changes.",
        },
        requestId: "request-merge-from-base",
      },
    });
  });

  test("forces a workspace git snapshot refresh after merge-from-base succeeds", async () => {
    const messages: unknown[] = [];
    const github = { invalidate: vi.fn() };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue(
        createWorkspaceGitSnapshot("/tmp/request-worktree", {
          git: {
            isDirty: false,
          },
        }),
      ),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });
    checkoutGitMocks.mergeFromBase.mockResolvedValue(undefined);

    await asSessionInternals(session).handleCheckoutMergeFromBaseRequest({
      type: "checkout_merge_from_base_request",
      cwd: "/tmp/request-worktree",
      baseRef: "main",
      requireCleanTarget: true,
      requestId: "request-merge-from-base-success",
    });

    expect(checkoutGitMocks.mergeFromBase).toHaveBeenCalledWith("/tmp/request-worktree", {
      baseRef: "main",
      requireCleanTarget: true,
    });
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/request-worktree", {
      force: true,
      reason: "merge-from-base",
    });
    expect(github.invalidate).toHaveBeenCalledWith({ cwd: "/tmp/request-worktree" });
    expect(messages).toContainEqual({
      type: "checkout_merge_from_base_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: true,
        error: null,
        requestId: "request-merge-from-base-success",
      },
    });
  });
});

describe("session checkout commit handling", () => {
  const tempDirs: string[] = [];
  const PRE_CHANGE_COMMIT_PROMPT = `Write a concise git commit message for the changes below.
Return JSON only with a single field 'message'.

Files changed:
M\tfile.txt\t(+1 -0)

diff --git a/file.txt b/file.txt
+hello
`;

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "commit-metadata-session-test-")));
    tempDirs.push(root);
    return root;
  }

  function writeConfig(repoRoot: string, config: unknown): void {
    writeFileSync(join(repoRoot, "paseo.json"), `${JSON.stringify(config)}\n`);
  }

  async function generateCommitPromptWithConfig(config: unknown): Promise<string> {
    const repoRoot = makeRoot();
    if (typeof config === "string") {
      writeFileSync(join(repoRoot, "paseo.json"), config);
    } else if (config !== undefined) {
      writeConfig(repoRoot, config);
    }

    const workspaceGitService = {
      getCheckoutDiff: vi.fn().mockResolvedValue({
        diff: "diff --git a/file.txt b/file.txt\n+hello\n",
        structured: [
          {
            path: "file.txt",
            additions: 1,
            deletions: 0,
            isNew: false,
            isDeleted: false,
            hunks: [],
            status: "ok",
          },
        ],
      }),
      getSnapshot: vi.fn().mockResolvedValue({}),
      resolveRepoRoot: vi.fn().mockResolvedValue(repoRoot),
    };
    agentResponseMocks.generateStructuredAgentResponseWithFallback.mockResolvedValue({
      message: "Update file",
    });
    checkoutGitMocks.commitChanges.mockResolvedValue(undefined);
    const session = createSessionForTest({ workspaceGitService });

    await asSessionInternals(session).handleCheckoutCommitRequest({
      type: "checkout_commit_request",
      cwd: join(repoRoot, "nested"),
      message: "",
      addAll: true,
      requestId: "request-generated-commit",
    });

    return String(
      agentResponseMocks.generateStructuredAgentResponseWithFallback.mock.calls[0]?.[0].prompt,
    );
  }

  test("forces a workspace git snapshot refresh after committing", async () => {
    const messages: unknown[] = [];
    const checkoutDiffManager = { scheduleRefreshForCwd: vi.fn() };
    const workspaceGitService = { getSnapshot: vi.fn().mockResolvedValue({}) };
    const session = createSessionForTest({ checkoutDiffManager, workspaceGitService, messages });

    checkoutGitMocks.commitChanges.mockResolvedValue(undefined);

    await asSessionInternals(session).handleCheckoutCommitRequest({
      type: "checkout_commit_request",
      cwd: "/tmp/request-worktree",
      message: "Ship it",
      addAll: true,
      requestId: "request-commit",
    });

    expect(checkoutGitMocks.commitChanges).toHaveBeenCalledWith("/tmp/request-worktree", {
      message: "Ship it",
      addAll: true,
    });
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledTimes(1);
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/request-worktree", {
      force: true,
      reason: "commit-changes",
    });
    expect(checkoutDiffManager.scheduleRefreshForCwd).toHaveBeenCalledWith("/tmp/request-worktree");
    expect(messages).toContainEqual({
      type: "checkout_commit_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: true,
        error: null,
        requestId: "request-commit",
      },
    });
  });

  test("generates commit messages from checkout diffs read through the workspace git service", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = {
      getCheckoutDiff: vi.fn().mockResolvedValue({
        diff: "diff --git a/file.txt b/file.txt\n+hello\n",
        structured: [
          {
            path: "file.txt",
            additions: 1,
            deletions: 0,
            isNew: false,
            isDeleted: false,
            hunks: [],
            status: "ok",
          },
        ],
      }),
      getSnapshot: vi.fn().mockResolvedValue({}),
    };
    agentResponseMocks.generateStructuredAgentResponseWithFallback.mockResolvedValue({
      message: "Update file",
    });
    checkoutGitMocks.commitChanges.mockResolvedValue(undefined);
    const session = createSessionForTest({ workspaceGitService, messages });

    await asSessionInternals(session).handleCheckoutCommitRequest({
      type: "checkout_commit_request",
      cwd: "/tmp/request-worktree",
      message: "",
      addAll: true,
      requestId: "request-generated-commit",
    });

    expect(workspaceGitService.getCheckoutDiff).toHaveBeenCalledTimes(1);
    expect(workspaceGitService.getCheckoutDiff).toHaveBeenCalledWith("/tmp/request-worktree", {
      mode: "uncommitted",
      includeStructured: true,
    });
    expect(agentResponseMocks.generateStructuredAgentResponseWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        persistSession: false,
        agentConfigOverrides: expect.objectContaining({
          title: "Commit generator",
          internal: true,
        }),
      }),
    );
    expect(checkoutGitMocks.commitChanges).toHaveBeenCalledWith("/tmp/request-worktree", {
      message: "Update file",
      addAll: true,
    });
    expect(messages).toContainEqual({
      type: "checkout_commit_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: true,
        error: null,
        requestId: "request-generated-commit",
      },
    });
  });

  test.each([
    ["paseo.json missing", undefined],
    ["paseo.json exists but invalid JSON", "{ nope"],
    ["paseo.json valid but missing metadataGeneration", {}],
    ["metadataGeneration is schema-invalid", { metadataGeneration: "not an object" }],
    [
      "metadataGeneration exists but missing commitMessage",
      { metadataGeneration: { pullRequest: { instructions: "Write a punchy PR." } } },
    ],
    [
      "commitMessage exists but instructions is undefined",
      { metadataGeneration: { commitMessage: {} } },
    ],
    [
      "commitMessage exists but instructions is empty",
      { metadataGeneration: { commitMessage: { instructions: "" } } },
    ],
    [
      "commitMessage exists but instructions is whitespace-only",
      { metadataGeneration: { commitMessage: { instructions: "   \n\t " } } },
    ],
  ])("keeps the pre-change commit prompt byte-identical when %s", async (_name, config) => {
    const prompt = await generateCommitPromptWithConfig(config);

    expect(prompt).toBe(PRE_CHANGE_COMMIT_PROMPT);
  });

  test("injects commit instructions between the default rules and JSON contract", async () => {
    const prompt = await generateCommitPromptWithConfig({
      metadataGeneration: {
        commitMessage: {
          instructions: "Use conventional commits.\nAccept XML-ish <scope> text.",
        },
      },
    });

    const defaultRuleIndex = prompt.indexOf("Write a concise git commit message");
    const openTagIndex = prompt.indexOf("<user-instructions>");
    const noticeIndex = prompt.indexOf("override the guidelines above");
    const userInstructionIndex = prompt.indexOf("Use conventional commits.");
    const closeTagIndex = prompt.indexOf("</user-instructions>");
    const jsonContractIndex = prompt.indexOf("Return JSON only");
    const fileListIndex = prompt.indexOf("Files changed:");
    const patchIndex = prompt.indexOf("diff --git");

    expect(defaultRuleIndex).toBeGreaterThanOrEqual(0);
    expect(defaultRuleIndex).toBeLessThan(openTagIndex);
    expect(openTagIndex).toBeLessThan(noticeIndex);
    expect(noticeIndex).toBeLessThan(userInstructionIndex);
    expect(userInstructionIndex).toBeLessThan(closeTagIndex);
    expect(closeTagIndex).toBeLessThan(jsonContractIndex);
    expect(jsonContractIndex).toBeLessThan(fileListIndex);
    expect(fileListIndex).toBeLessThan(patchIndex);
  });

  test("keeps the commit fallback when structured generation fails", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = {
      getCheckoutDiff: vi.fn().mockResolvedValue({
        diff: "diff --git a/file.txt b/file.txt\n+hello\n",
        structured: [],
      }),
      getSnapshot: vi.fn().mockResolvedValue({}),
      resolveRepoRoot: vi.fn().mockResolvedValue(makeRoot()),
    };
    agentResponseMocks.generateStructuredAgentResponseWithFallback.mockRejectedValue(
      new StructuredAgentFallbackError([]),
    );
    checkoutGitMocks.commitChanges.mockResolvedValue(undefined);
    const session = createSessionForTest({ workspaceGitService, messages });

    await asSessionInternals(session).handleCheckoutCommitRequest({
      type: "checkout_commit_request",
      cwd: "/tmp/request-worktree",
      message: "",
      addAll: true,
      requestId: "request-generated-commit-fallback",
    });

    expect(checkoutGitMocks.commitChanges).toHaveBeenCalledWith("/tmp/request-worktree", {
      message: "Update files",
      addAll: true,
    });
    expect(messages).toContainEqual({
      type: "checkout_commit_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: true,
        error: null,
        requestId: "request-generated-commit-fallback",
      },
    });
  });

  test("does not force a workspace git snapshot refresh when commit fails", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = { getSnapshot: vi.fn().mockResolvedValue({}) };
    const session = createSessionForTest({ workspaceGitService, messages });
    checkoutGitMocks.commitChanges.mockRejectedValue(new Error("nothing to commit"));

    await asSessionInternals(session).handleCheckoutCommitRequest({
      type: "checkout_commit_request",
      cwd: "/tmp/request-worktree",
      message: "Ship it",
      addAll: true,
      requestId: "request-commit-failure",
    });

    expect(workspaceGitService.getSnapshot).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "checkout_commit_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: false,
        error: {
          code: "UNKNOWN",
          message: "nothing to commit",
        },
        requestId: "request-commit-failure",
      },
    });
  });
});

describe("session checkout pull request creation", () => {
  const tempDirs: string[] = [];
  const PRE_CHANGE_PULL_REQUEST_PROMPT = `Write a pull request title and body for the changes below.
Return JSON only with fields 'title' and 'body'.

Files changed:
M\tfile.txt\t(+1 -0)

diff --git a/file.txt b/file.txt
+hello
`;

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pr-metadata-session-test-")));
    tempDirs.push(root);
    return root;
  }

  function writeConfig(repoRoot: string, config: unknown): void {
    writeFileSync(join(repoRoot, "paseo.json"), `${JSON.stringify(config)}\n`);
  }

  async function generatePullRequestCallWithConfig(config: unknown): Promise<unknown> {
    const repoRoot = makeRoot();
    if (typeof config === "string") {
      writeFileSync(join(repoRoot, "paseo.json"), config);
    } else if (config !== undefined) {
      writeConfig(repoRoot, config);
    }

    const workspaceGitService = {
      getCheckoutDiff: vi.fn().mockResolvedValue({
        diff: "diff --git a/file.txt b/file.txt\n+hello\n",
        structured: [
          {
            path: "file.txt",
            additions: 1,
            deletions: 0,
            isNew: false,
            isDeleted: false,
            hunks: [],
            status: "ok",
          },
        ],
      }),
      resolveRepoRoot: vi.fn().mockResolvedValue(repoRoot),
    };
    agentResponseMocks.generateStructuredAgentResponseWithFallback.mockResolvedValue({
      title: "Update file",
      body: "Updates file.",
    });
    checkoutGitMocks.createPullRequest.mockResolvedValue({
      url: "https://github.com/getpaseo/paseo/pull/1",
      number: 1,
    });
    const session = createSessionForTest({ workspaceGitService });

    await asSessionInternals(session).handleCheckoutPrCreateRequest({
      type: "checkout_pr_create_request",
      cwd: join(repoRoot, "nested"),
      baseRef: "main",
      title: "",
      body: "",
      requestId: "request-generated-pr",
    });

    return agentResponseMocks.generateStructuredAgentResponseWithFallback.mock.calls[0]?.[0];
  }

  async function generatePullRequestPromptWithConfig(config: unknown): Promise<string> {
    const call = await generatePullRequestCallWithConfig(config);
    return String((call as { prompt?: unknown } | undefined)?.prompt);
  }

  test("generates PR text from checkout diffs read through the workspace git service", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = {
      getCheckoutDiff: vi.fn().mockResolvedValue({
        diff: "diff --git a/file.txt b/file.txt\n+hello\n",
        structured: [
          {
            path: "file.txt",
            additions: 1,
            deletions: 0,
            isNew: false,
            isDeleted: false,
            hunks: [],
            status: "ok",
          },
        ],
      }),
    };
    agentResponseMocks.generateStructuredAgentResponseWithFallback.mockResolvedValue({
      title: "Update file",
      body: "Updates file.",
    });
    checkoutGitMocks.createPullRequest.mockResolvedValue({
      url: "https://github.com/getpaseo/paseo/pull/1",
      number: 1,
    });
    const session = createSessionForTest({ workspaceGitService, messages });

    await asSessionInternals(session).handleCheckoutPrCreateRequest({
      type: "checkout_pr_create_request",
      cwd: "/tmp/request-worktree",
      baseRef: "main",
      title: "",
      body: "",
      requestId: "request-generated-pr",
    });

    expect(workspaceGitService.getCheckoutDiff).toHaveBeenCalledTimes(1);
    expect(workspaceGitService.getCheckoutDiff).toHaveBeenCalledWith("/tmp/request-worktree", {
      mode: "base",
      baseRef: "main",
      includeStructured: true,
    });
    expect(agentResponseMocks.generateStructuredAgentResponseWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        persistSession: false,
        agentConfigOverrides: expect.objectContaining({
          title: "PR generator",
          internal: true,
        }),
      }),
    );
    expect(checkoutGitMocks.createPullRequest).toHaveBeenCalledWith(
      "/tmp/request-worktree",
      {
        title: "Update file",
        body: "Updates file.",
        base: "main",
      },
      expect.anything(),
    );
    expect(messages).toContainEqual({
      type: "checkout_pr_create_response",
      payload: {
        cwd: "/tmp/request-worktree",
        url: "https://github.com/getpaseo/paseo/pull/1",
        number: 1,
        error: null,
        requestId: "request-generated-pr",
      },
    });
  });

  test.each([
    ["paseo.json missing", undefined],
    ["paseo.json exists but invalid JSON", "{ nope"],
    ["paseo.json valid but missing metadataGeneration", {}],
    ["metadataGeneration is schema-invalid", { metadataGeneration: "not an object" }],
    [
      "metadataGeneration exists but missing pullRequest",
      { metadataGeneration: { commitMessage: { instructions: "Use conventional commits." } } },
    ],
    [
      "pullRequest exists but instructions is undefined",
      { metadataGeneration: { pullRequest: {} } },
    ],
    [
      "pullRequest exists but instructions is empty",
      { metadataGeneration: { pullRequest: { instructions: "" } } },
    ],
    [
      "pullRequest exists but instructions is whitespace-only",
      { metadataGeneration: { pullRequest: { instructions: "   \n\t " } } },
    ],
  ])("keeps the pre-change PR prompt byte-identical when %s", async (_name, config) => {
    const prompt = await generatePullRequestPromptWithConfig(config);

    expect(prompt).toBe(PRE_CHANGE_PULL_REQUEST_PROMPT);
  });

  test("injects PR instructions between the default rules and JSON contract", async () => {
    const prompt = await generatePullRequestPromptWithConfig({
      metadataGeneration: {
        pullRequest: {
          instructions: "Use a terse title.\nKeep literal <ticket> text.",
        },
      },
    });

    const defaultRuleIndex = prompt.indexOf("Write a pull request title and body");
    const openTagIndex = prompt.indexOf("<user-instructions>");
    const noticeIndex = prompt.indexOf("override the guidelines above");
    const userInstructionIndex = prompt.indexOf("Use a terse title.");
    const closeTagIndex = prompt.indexOf("</user-instructions>");
    const jsonContractIndex = prompt.indexOf("Return JSON only");
    const fileListIndex = prompt.indexOf("Files changed:");
    const patchIndex = prompt.indexOf("diff --git");

    expect(defaultRuleIndex).toBeGreaterThanOrEqual(0);
    expect(defaultRuleIndex).toBeLessThan(openTagIndex);
    expect(openTagIndex).toBeLessThan(noticeIndex);
    expect(noticeIndex).toBeLessThan(userInstructionIndex);
    expect(userInstructionIndex).toBeLessThan(closeTagIndex);
    expect(closeTagIndex).toBeLessThan(jsonContractIndex);
    expect(jsonContractIndex).toBeLessThan(fileListIndex);
    expect(fileListIndex).toBeLessThan(patchIndex);
  });

  test("keeps PR generation as one structured call with title and body schema", async () => {
    const call = await generatePullRequestCallWithConfig({
      metadataGeneration: {
        pullRequest: {
          instructions: "Use release-note style.",
        },
      },
    });
    const schema = (call as { schema?: { safeParse?: (value: unknown) => { success: boolean } } })
      .schema;

    expect(agentResponseMocks.generateStructuredAgentResponseWithFallback).toHaveBeenCalledTimes(1);
    expect(call).toMatchObject({
      schemaName: "PullRequest",
      persistSession: false,
      agentConfigOverrides: {
        title: "PR generator",
        internal: true,
      },
    });
    expect(schema?.safeParse?.({ title: "Update file", body: "Updates file." }).success).toBe(true);
    expect(schema?.safeParse?.({ title: "Update file" }).success).toBe(false);
  });

  test("keeps the PR fallback when structured generation fails", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = {
      getCheckoutDiff: vi.fn().mockResolvedValue({
        diff: "diff --git a/file.txt b/file.txt\n+hello\n",
        structured: [],
      }),
      resolveRepoRoot: vi.fn().mockResolvedValue(makeRoot()),
    };
    agentResponseMocks.generateStructuredAgentResponseWithFallback.mockRejectedValue(
      new StructuredAgentFallbackError([]),
    );
    checkoutGitMocks.createPullRequest.mockResolvedValue({
      url: "https://github.com/getpaseo/paseo/pull/9",
      number: 9,
    });
    const session = createSessionForTest({ workspaceGitService, messages });

    await asSessionInternals(session).handleCheckoutPrCreateRequest({
      type: "checkout_pr_create_request",
      cwd: "/tmp/request-worktree",
      baseRef: "main",
      title: "",
      body: "",
      requestId: "request-generated-pr-fallback",
    });

    expect(checkoutGitMocks.createPullRequest).toHaveBeenCalledWith(
      "/tmp/request-worktree",
      {
        title: "Update changes",
        body: "Automated PR generated by Paseo.",
        base: "main",
      },
      expect.anything(),
    );
    expect(messages).toContainEqual({
      type: "checkout_pr_create_response",
      payload: {
        cwd: "/tmp/request-worktree",
        url: "https://github.com/getpaseo/paseo/pull/9",
        number: 9,
        error: null,
        requestId: "request-generated-pr-fallback",
      },
    });
  });

  test("forces workspace git and GitHub refresh after creating a pull request", async () => {
    const messages: unknown[] = [];
    const github = { invalidate: vi.fn() };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue({}),
    };
    checkoutGitMocks.createPullRequest.mockResolvedValue({
      url: "https://github.com/getpaseo/paseo/pull/2",
      number: 2,
    });
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await asSessionInternals(session).handleCheckoutPrCreateRequest({
      type: "checkout_pr_create_request",
      cwd: "/tmp/request-worktree",
      baseRef: "main",
      title: "Update file",
      body: "Updates file.",
      requestId: "request-pr-create",
    });

    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/request-worktree", {
      force: true,
      reason: "create-pr",
    });
    expect(github.invalidate).toHaveBeenCalledWith({ cwd: "/tmp/request-worktree" });
    expect(messages).toContainEqual({
      type: "checkout_pr_create_response",
      payload: {
        cwd: "/tmp/request-worktree",
        url: "https://github.com/getpaseo/paseo/pull/2",
        number: 2,
        error: null,
        requestId: "request-pr-create",
      },
    });
  });
});

describe("session checkout pull request merge", () => {
  test("merges the current pull request and refreshes GitHub state", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      mergePullRequest: vi.fn().mockResolvedValue({ success: true }),
    };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue({
        github: {
          pullRequest: {
            number: 42,
          },
        },
      }),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await asSessionInternals(session).handleCheckoutPrMergeRequest({
      type: "checkout_pr_merge_request",
      cwd: "/tmp/request-worktree",
      mergeMethod: "squash",
      requestId: "request-pr-merge",
    });

    expect(github.mergePullRequest).toHaveBeenCalledWith({
      cwd: "/tmp/request-worktree",
      prNumber: 42,
      mergeMethod: "squash",
    });
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/request-worktree", {
      force: true,
      reason: "merge-pr",
    });
    expect(github.invalidate).toHaveBeenCalledWith({ cwd: "/tmp/request-worktree" });
    expect(messages).toContainEqual({
      type: "checkout_pr_merge_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: true,
        error: null,
        requestId: "request-pr-merge",
      },
    });
  });

  test("surfaces merge errors verbatim", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      mergePullRequest: vi.fn().mockRejectedValue(new Error("base branch has conflicts")),
    };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue({
        github: {
          pullRequest: {
            number: 42,
          },
        },
      }),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await asSessionInternals(session).handleCheckoutPrMergeRequest({
      type: "checkout_pr_merge_request",
      cwd: "/tmp/request-worktree",
      mergeMethod: "merge",
      requestId: "request-pr-merge-failure",
    });

    expect(messages).toContainEqual({
      type: "checkout_pr_merge_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: false,
        error: {
          code: "UNKNOWN",
          message: "base branch has conflicts",
        },
        requestId: "request-pr-merge-failure",
      },
    });
  });
});

describe("session checkout pull and push handling", () => {
  test("forces workspace git and GitHub refresh after pulling", async () => {
    const messages: unknown[] = [];
    const github = { invalidate: vi.fn() };
    const workspaceGitService = { getSnapshot: vi.fn().mockResolvedValue({}) };
    const session = createSessionForTest({ github, workspaceGitService, messages });
    checkoutGitMocks.pullCurrentBranch.mockResolvedValue(undefined);

    await asSessionInternals(session).handleCheckoutPullRequest({
      type: "checkout_pull_request",
      cwd: "/tmp/request-worktree",
      requestId: "request-pull",
    });

    expect(checkoutGitMocks.pullCurrentBranch).toHaveBeenCalledWith("/tmp/request-worktree");
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/request-worktree", {
      force: true,
      reason: "pull",
    });
    expect(github.invalidate).toHaveBeenCalledWith({ cwd: "/tmp/request-worktree" });
    expect(messages).toContainEqual({
      type: "checkout_pull_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: true,
        error: null,
        requestId: "request-pull",
      },
    });
  });

  test("forces workspace git and GitHub refresh after pushing", async () => {
    const messages: unknown[] = [];
    const github = { invalidate: vi.fn() };
    const workspaceGitService = { getSnapshot: vi.fn().mockResolvedValue({}) };
    const session = createSessionForTest({ github, workspaceGitService, messages });
    checkoutGitMocks.pushCurrentBranch.mockResolvedValue(undefined);

    await asSessionInternals(session).handleCheckoutPushRequest({
      type: "checkout_push_request",
      cwd: "/tmp/request-worktree",
      requestId: "request-push",
    });

    expect(checkoutGitMocks.pushCurrentBranch).toHaveBeenCalledWith("/tmp/request-worktree");
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/request-worktree", {
      force: true,
      reason: "push",
    });
    expect(github.invalidate).toHaveBeenCalledWith({ cwd: "/tmp/request-worktree" });
    expect(messages).toContainEqual({
      type: "checkout_push_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: true,
        error: null,
        requestId: "request-push",
      },
    });
  });
});

describe("session checkout status handling", () => {
  test("returns checkout status from the workspace git service snapshot", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue(createWorkspaceGitSnapshot("/tmp/service-worktree")),
      peekSnapshot: vi.fn(),
    };
    const session = createSessionForTest({ workspaceGitService, messages });

    await asSessionInternals(session).handleCheckoutStatusRequest({
      type: "checkout_status_request",
      cwd: "/tmp/service-worktree",
      requestId: "request-status",
    });

    expect(workspaceGitService.getSnapshot).toHaveBeenCalledTimes(1);
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/service-worktree");
    expect(checkoutGitMocks.getCheckoutStatus).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "checkout_status_response",
      payload: {
        cwd: "/tmp/service-worktree",
        isGit: true,
        repoRoot: "/tmp/service-worktree",
        mainRepoRoot: null,
        currentBranch: "feature/service",
        isDirty: true,
        baseRef: "main",
        aheadBehind: { ahead: 2, behind: 1 },
        aheadOfOrigin: 2,
        behindOfOrigin: 1,
        hasRemote: true,
        remoteUrl: "https://github.com/getpaseo/paseo.git",
        isPaseoOwnedWorktree: false,
        error: null,
        requestId: "request-status",
      },
    });
  });

  test("returns fresh service data on the first checkout status read for a cwd", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue(
        createWorkspaceGitSnapshot("/tmp/cold-worktree", {
          git: {
            currentBranch: "fresh-branch",
            isDirty: false,
            aheadBehind: { ahead: 4, behind: 0 },
            aheadOfOrigin: 4,
            behindOfOrigin: 0,
          },
        }),
      ),
      peekSnapshot: vi.fn(() => null),
    };
    const session = createSessionForTest({ workspaceGitService, messages });

    await asSessionInternals(session).handleCheckoutStatusRequest({
      type: "checkout_status_request",
      cwd: "/tmp/cold-worktree",
      requestId: "request-cold-status",
    });

    expect(workspaceGitService.peekSnapshot).not.toHaveBeenCalled();
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledTimes(1);
    expect(messages).toContainEqual({
      type: "checkout_status_response",
      payload: expect.objectContaining({
        cwd: "/tmp/cold-worktree",
        isGit: true,
        currentBranch: "fresh-branch",
        isDirty: false,
        aheadBehind: { ahead: 4, behind: 0 },
        error: null,
        requestId: "request-cold-status",
      }),
    });
  });
});

describe("session workspace descriptors", () => {
  test("fetch_workspaces_request includes project placement for a GitHub-backed workspace", async () => {
    const messages: unknown[] = [];
    const workspace = {
      workspaceId: "ws-gh",
      projectId: "remote:github.com/acme/app",
      cwd: "/repo/app",
      kind: "local_checkout" as const,
      displayName: "app",
      archivedAt: null,
    };
    const project = {
      projectId: "remote:github.com/acme/app",
      rootPath: "/repo/app",
      kind: "git" as const,
      displayName: "acme/app",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
    };
    const session = createSessionForTest({
      messages,
      workspaceRegistry: { get: vi.fn(), list: vi.fn().mockResolvedValue([workspace]) },
      projectRegistry: { list: vi.fn().mockResolvedValue([project]), get: vi.fn() },
      workspaceGitService: {
        getSnapshot: vi.fn(),
        peekSnapshot: vi.fn(() =>
          createWorkspaceGitSnapshot("/repo/app", {
            git: {
              remoteUrl: "https://github.com/acme/app.git",
              currentBranch: "main",
              isPaseoOwnedWorktree: false,
              mainRepoRoot: null,
            },
          }),
        ),
        registerWorkspace: vi.fn(() => () => {}),
      },
    });

    await session.handleMessage({
      type: "fetch_workspaces_request",
      requestId: "fetch-workspaces-gh",
    });

    expect(messages).toContainEqual({
      type: "fetch_workspaces_response",
      payload: expect.objectContaining({
        requestId: "fetch-workspaces-gh",
        entries: [
          expect.objectContaining({
            id: "ws-gh",
            project: {
              projectKey: "remote:github.com/acme/app",
              projectName: "acme/app",
              checkout: {
                cwd: "/repo/app",
                isGit: true,
                currentBranch: "app",
                remoteUrl: null,
                worktreeRoot: "/repo/app",
                isPaseoOwnedWorktree: false,
                mainRepoRoot: null,
              },
            },
          }),
        ],
      }),
    });
  });

  test("fetch_workspaces_request includes repo-root fallback placement for a workspace without remote", async () => {
    const messages: unknown[] = [];
    const workspace = {
      workspaceId: "ws-local",
      projectId: "/repo/local",
      cwd: "/repo/local",
      kind: "local_checkout" as const,
      displayName: "local",
      archivedAt: null,
    };
    const project = {
      projectId: "/repo/local",
      rootPath: "/repo/local",
      kind: "git" as const,
      displayName: "local",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
    };
    const session = createSessionForTest({
      messages,
      workspaceRegistry: { get: vi.fn(), list: vi.fn().mockResolvedValue([workspace]) },
      projectRegistry: { list: vi.fn().mockResolvedValue([project]), get: vi.fn() },
      workspaceGitService: {
        getSnapshot: vi.fn(),
        peekSnapshot: vi.fn(() =>
          createWorkspaceGitSnapshot("/repo/local", {
            git: {
              remoteUrl: null,
              currentBranch: "main",
              isPaseoOwnedWorktree: false,
              mainRepoRoot: null,
            },
          }),
        ),
        registerWorkspace: vi.fn(() => () => {}),
      },
    });

    await session.handleMessage({
      type: "fetch_workspaces_request",
      requestId: "fetch-workspaces-local",
    });

    expect(messages).toContainEqual({
      type: "fetch_workspaces_response",
      payload: expect.objectContaining({
        requestId: "fetch-workspaces-local",
        entries: [
          expect.objectContaining({
            id: "ws-local",
            project: {
              projectKey: "/repo/local",
              projectName: "local",
              checkout: {
                cwd: "/repo/local",
                isGit: true,
                currentBranch: "local",
                remoteUrl: null,
                worktreeRoot: "/repo/local",
                isPaseoOwnedWorktree: false,
                mainRepoRoot: null,
              },
            },
          }),
        ],
      }),
    });
  });

  test("reads descriptor diff stat from the workspace git service snapshot", async () => {
    const workspaceGitService = {
      getSnapshot: vi.fn(),
      peekSnapshot: vi.fn(() =>
        createWorkspaceGitSnapshot("/tmp/workspace", {
          git: { diffStat: { additions: 7, deletions: 2 } },
        }),
      ),
    };
    const session = createSessionForTest({ workspaceGitService });
    checkoutGitMocks.getCachedCheckoutShortstat.mockReturnValue({
      additions: 99,
      deletions: 88,
    });

    const descriptor = await asSessionInternals(session).describeWorkspaceRecord(
      {
        workspaceId: "workspace-1",
        projectId: "project-1",
        cwd: "/tmp/workspace",
        kind: "checkout",
        displayName: "Workspace",
      },
      {
        projectId: "project-1",
        rootPath: "/tmp/workspace",
        displayName: "Project",
        kind: "git",
      },
    );

    expect(workspaceGitService.peekSnapshot).toHaveBeenCalledWith("/tmp/workspace");
    expect(workspaceGitService.getSnapshot).not.toHaveBeenCalled();
    expect(checkoutGitMocks.getCachedCheckoutShortstat).not.toHaveBeenCalled();
    expect(checkoutGitMocks.warmCheckoutShortstatInBackground).not.toHaveBeenCalled();
    expect(descriptor.diffStat).toEqual({ additions: 7, deletions: 2 });
  });

  test("does not cold-load git data while describing a workspace", async () => {
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue(createWorkspaceGitSnapshot("/tmp/workspace")),
      peekSnapshot: vi.fn(() => null),
    };
    const session = createSessionForTest({ workspaceGitService });

    const descriptor = await asSessionInternals(session).describeWorkspaceRecordWithGitData(
      {
        workspaceId: "workspace-1",
        projectId: "project-1",
        cwd: "/tmp/workspace",
        kind: "checkout",
        displayName: "Workspace",
      },
      {
        projectId: "project-1",
        rootPath: "/tmp/workspace",
        displayName: "Project",
        kind: "git",
      },
    );

    expect(workspaceGitService.peekSnapshot).toHaveBeenCalledWith("/tmp/workspace");
    expect(workspaceGitService.getSnapshot).not.toHaveBeenCalled();
    expect(descriptor.diffStat).toBeNull();
    expect(descriptor.gitRuntime).toBeUndefined();
  });
});

describe("session branch validation", () => {
  test("validates branches through the workspace git service", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = {
      getSnapshot: vi.fn(),
      peekSnapshot: vi.fn(),
      validateBranchRef: vi
        .fn()
        .mockResolvedValue({ kind: "remote-only", name: "feature", remoteRef: "origin/feature" }),
    };
    const session = createSessionForTest({ workspaceGitService, messages });

    await asSessionInternals(session).handleValidateBranchRequest({
      type: "validate_branch_request",
      cwd: "/tmp/repo",
      branchName: "feature",
      requestId: "request-validate-service",
    });

    expect(workspaceGitService.validateBranchRef).toHaveBeenCalledTimes(1);
    expect(workspaceGitService.validateBranchRef).toHaveBeenCalledWith("/tmp/repo", "feature");
    expect(checkoutGitMocks.resolveBranchCheckout).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "validate_branch_response",
      payload: {
        exists: true,
        resolvedRef: "origin/feature",
        isRemote: true,
        error: null,
        requestId: "request-validate-service",
      },
    });
  });

  test("does not validate tags as branches", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "paseo-session-branch-validation-"));
    const repoDir = join(tempDir, "repo");

    try {
      execSync(`git init -b main ${repoDir}`);
      execSync("git config user.email 'test@test.com'", { cwd: repoDir });
      execSync("git config user.name 'Test'", { cwd: repoDir });
      writeFileSync(join(repoDir, "README.md"), "hello\n");
      execSync("git add README.md", { cwd: repoDir });
      execSync("git -c commit.gpgsign=false commit -m init", { cwd: repoDir });
      execSync("git tag v1", { cwd: repoDir });

      const messages: unknown[] = [];
      const workspaceGitService = {
        getSnapshot: vi.fn(),
        peekSnapshot: vi.fn(),
        validateBranchRef: vi.fn().mockResolvedValue({ kind: "not-found" }),
      };
      const session = createSessionForTest({ workspaceGitService, messages });

      await session.handleMessage({
        type: "validate_branch_request",
        cwd: repoDir,
        branchName: "v1",
        requestId: "request-validate-tag",
      });

      expect(messages).toContainEqual({
        type: "validate_branch_response",
        payload: {
          exists: false,
          resolvedRef: null,
          isRemote: false,
          error: null,
          requestId: "request-validate-tag",
        },
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("session branch creation handling", () => {
  test("validates the base branch through the workspace git service", async () => {
    const workspaceGitService = {
      getSnapshot: vi.fn(),
      validateBranchRef: vi.fn().mockResolvedValue({ kind: "not-found" }),
      hasLocalBranch: vi.fn(),
    };
    const session = createSessionForTest({ workspaceGitService });

    await expect(
      asSessionInternals(session).createBranchFromBase({
        cwd: "/tmp/repo",
        baseBranch: "missing-base",
        newBranchName: "feature/new-work",
      }),
    ).rejects.toThrow("Base branch not found: missing-base");

    expect(workspaceGitService.validateBranchRef).toHaveBeenCalledTimes(1);
    expect(workspaceGitService.validateBranchRef).toHaveBeenCalledWith("/tmp/repo", "missing-base");
    expect(workspaceGitService.hasLocalBranch).not.toHaveBeenCalled();
    expect(spawnMocks.execCommand).not.toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--verify", "missing-base"],
      { cwd: "/tmp/repo" },
    );
  });

  test("checks local branch existence through the workspace git service", async () => {
    const workspaceGitService = {
      getSnapshot: vi.fn(),
      validateBranchRef: vi.fn().mockResolvedValue({ kind: "local", name: "main" }),
      hasLocalBranch: vi.fn().mockResolvedValue(true),
    };
    const session = createSessionForTest({ workspaceGitService });

    await expect(
      asSessionInternals(session).createBranchFromBase({
        cwd: "/tmp/repo",
        baseBranch: "main",
        newBranchName: "feature/existing",
      }),
    ).rejects.toThrow("Branch already exists: feature/existing");

    expect(workspaceGitService.validateBranchRef).toHaveBeenCalledWith("/tmp/repo", "main");
    expect(workspaceGitService.hasLocalBranch).toHaveBeenCalledTimes(1);
    expect(workspaceGitService.hasLocalBranch).toHaveBeenCalledWith(
      "/tmp/repo",
      "feature/existing",
    );
    expect(spawnMocks.execCommand).not.toHaveBeenCalledWith(
      "git",
      ["show-ref", "--verify", "--quiet", "refs/heads/feature/existing"],
      { cwd: "/tmp/repo" },
    );
  });

  test("forces a workspace git snapshot refresh after creating a branch", async () => {
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue(
        createWorkspaceGitSnapshot("/tmp/repo", {
          git: {
            isDirty: false,
          },
        }),
      ),
      validateBranchRef: vi.fn().mockResolvedValue({ kind: "local", name: "main" }),
      hasLocalBranch: vi.fn().mockResolvedValue(false),
    };
    const session = createSessionForTest({ workspaceGitService });
    spawnMocks.execCommand.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      truncated: false,
    });

    await asSessionInternals(session).createBranchFromBase({
      cwd: "/tmp/repo",
      baseBranch: "main",
      newBranchName: "feature/new-work",
    });

    expect(spawnMocks.execCommand).toHaveBeenCalledWith(
      "git",
      ["checkout", "-b", "feature/new-work", "main"],
      { cwd: "/tmp/repo" },
    );
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/repo", {
      force: true,
      reason: "create-branch",
    });
  });
});

describe("session checkout switch branch handling", () => {
  test("forces a workspace git snapshot refresh after switching branches", async () => {
    const messages: unknown[] = [];
    const github = { invalidate: vi.fn() };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue(
        createWorkspaceGitSnapshot("/tmp/repo", {
          git: {
            isDirty: false,
          },
        }),
      ),
      validateBranchRef: vi.fn().mockResolvedValue({ kind: "local", name: "release" }),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });
    checkoutGitMocks.checkoutResolvedBranch.mockResolvedValue({ source: "local" });

    await asSessionInternals(session).handleCheckoutSwitchBranchRequest({
      type: "checkout_switch_branch_request",
      cwd: "/tmp/repo",
      branch: "release",
      requestId: "request-switch",
    });

    expect(checkoutGitMocks.checkoutResolvedBranch).toHaveBeenCalledWith({
      cwd: "/tmp/repo",
      resolution: { kind: "local", name: "release" },
    });
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/repo", {
      force: true,
      reason: "switch-branch",
    });
    expect(github.invalidate).toHaveBeenCalledWith({ cwd: "/tmp/repo" });
    expect(messages).toContainEqual({
      type: "checkout_switch_branch_response",
      payload: {
        cwd: "/tmp/repo",
        success: true,
        branch: "release",
        source: "local",
        error: null,
        requestId: "request-switch",
      },
    });
  });
});

describe("session branch suggestions handling", () => {
  test("lists branch suggestions through the workspace git service", async () => {
    const messages: unknown[] = [];
    const branchDetails = [
      { name: "feature/service", committerDate: 10, hasLocal: true, hasRemote: false },
    ];
    const workspaceGitService = {
      getSnapshot: vi.fn(),
      suggestBranchesForCwd: vi.fn().mockResolvedValue(branchDetails),
      peekSnapshot: vi.fn(),
    };
    const session = createSessionForTest({ workspaceGitService, messages });

    await asSessionInternals(session).handleBranchSuggestionsRequest({
      type: "branch_suggestions_request",
      cwd: "/tmp/repo",
      query: "service",
      limit: 5,
      requestId: "request-branches",
    });

    expect(workspaceGitService.suggestBranchesForCwd).toHaveBeenCalledTimes(1);
    expect(workspaceGitService.suggestBranchesForCwd).toHaveBeenCalledWith("/tmp/repo", {
      query: "service",
      limit: 5,
    });
    expect(checkoutGitMocks.listBranchSuggestions).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "branch_suggestions_response",
      payload: {
        branches: ["feature/service"],
        branchDetails,
        error: null,
        requestId: "request-branches",
      },
    });
  });
});

describe("session stash list handling", () => {
  test("lists stashes through the workspace git service", async () => {
    const messages: unknown[] = [];
    const entries = [
      {
        index: 0,
        message: "paseo-auto-stash: feature",
        branch: "feature",
        isPaseo: true,
      },
    ];
    const workspaceGitService = {
      getSnapshot: vi.fn(),
      listStashes: vi.fn().mockResolvedValue(entries),
      peekSnapshot: vi.fn(),
    };
    const session = createSessionForTest({ workspaceGitService, messages });

    await asSessionInternals(session).handleStashListRequest({
      type: "stash_list_request",
      cwd: "/tmp/repo",
      paseoOnly: true,
      requestId: "request-stashes",
    });

    expect(workspaceGitService.listStashes).toHaveBeenCalledTimes(1);
    expect(workspaceGitService.listStashes).toHaveBeenCalledWith("/tmp/repo", {
      paseoOnly: true,
    });
    expect(messages).toContainEqual({
      type: "stash_list_response",
      payload: { cwd: "/tmp/repo", entries, error: null, requestId: "request-stashes" },
    });
  });
});

describe("session stash mutation handling", () => {
  test("forces a workspace git snapshot refresh after pushing a stash", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = { getSnapshot: vi.fn().mockResolvedValue({}) };
    const session = createSessionForTest({ workspaceGitService, messages });
    spawnMocks.execCommand.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      truncated: false,
    });

    await asSessionInternals(session).handleStashSaveRequest({
      type: "stash_save_request",
      cwd: "/tmp/repo",
      branch: "feature",
      requestId: "request-stash-push",
    });

    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/repo", {
      force: true,
      reason: "stash-push",
    });
    expect(messages).toContainEqual({
      type: "stash_save_response",
      payload: {
        cwd: "/tmp/repo",
        success: true,
        error: null,
        requestId: "request-stash-push",
      },
    });
  });

  test("forces a workspace git snapshot refresh after popping a stash", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = { getSnapshot: vi.fn().mockResolvedValue({}) };
    const session = createSessionForTest({ workspaceGitService, messages });
    spawnMocks.execCommand.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      truncated: false,
    });

    await asSessionInternals(session).handleStashPopRequest({
      type: "stash_pop_request",
      cwd: "/tmp/repo",
      stashIndex: 0,
      requestId: "request-stash-pop",
    });

    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/repo", {
      force: true,
      reason: "stash-pop",
    });
    expect(messages).toContainEqual({
      type: "stash_pop_response",
      payload: {
        cwd: "/tmp/repo",
        success: true,
        error: null,
        requestId: "request-stash-pop",
      },
    });
  });
});

describe("session paseo worktree creation handling", () => {
  test("forces workspace git refreshes for the source repo and created worktree", async () => {
    const workspaceGitService = { getSnapshot: vi.fn().mockResolvedValue({}) };
    const session = createSessionForTest({ workspaceGitService });
    paseoWorktreeServiceMocks.createPaseoWorktree.mockResolvedValue({
      repoRoot: "/tmp/repo",
      worktree: {
        branchName: "feature/new-worktree",
        worktreePath: "/tmp/paseo/worktrees/new-worktree",
      },
      workspace: {
        workspaceId: "workspace-new-worktree",
        projectId: "project-repo",
        cwd: "/tmp/paseo/worktrees/new-worktree",
        kind: "worktree",
        displayName: "feature/new-worktree",
      },
      created: true,
    });

    await asSessionInternals(session).createPaseoWorktree({
      cwd: "/tmp/repo",
      worktreeSlug: "new-worktree",
      runSetup: false,
    });

    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/repo", {
      force: true,
      reason: "create-worktree",
    });
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith(
      "/tmp/paseo/worktrees/new-worktree",
      {
        force: true,
        reason: "create-worktree",
      },
    );
  });
});

describe("session workspace script handling", () => {
  test("passes service-owned git metadata into workspace script spawning", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = {
      peekSnapshot: vi.fn(() => null),
      getWorkspaceGitMetadata: vi.fn().mockResolvedValue({
        projectKind: "git",
        projectDisplayName: "getpaseo/paseo",
        workspaceDisplayName: "feature/service-scripts",
        projectSlug: "paseo",
        currentBranch: "feature/service-scripts",
      }),
    };
    const workspaceRegistry = {
      get: vi.fn().mockResolvedValue({
        workspaceId: "workspace-1",
        cwd: "/tmp/repo",
      }),
    };
    spawnMocks.spawnWorkspaceScript.mockResolvedValue({
      scriptName: "api",
      terminalId: "terminal-1",
    });
    const session = createSessionForTest({
      workspaceGitService,
      workspaceRegistry,
      terminalManager: { subscribeTerminalsChanged: vi.fn(() => () => {}) },
      scriptRouteStore: { listRoutesForWorkspace: vi.fn(() => []) },
      scriptRuntimeStore: { listForWorkspace: vi.fn(() => []) },
      getDaemonTcpPort: () => 6767,
      getDaemonTcpHost: () => "127.0.0.1",
      messages,
    });

    await asSessionInternals(session).handleStartWorkspaceScriptRequest({
      type: "start_workspace_script_request",
      workspaceId: "workspace-1",
      scriptName: "api",
      requestId: "request-script",
    });

    expect(workspaceGitService.getWorkspaceGitMetadata).toHaveBeenCalledTimes(1);
    expect(workspaceGitService.getWorkspaceGitMetadata).toHaveBeenCalledWith("/tmp/repo");
    expect(spawnMocks.spawnWorkspaceScript).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: "/tmp/repo",
        workspaceId: "workspace-1",
        projectSlug: "paseo",
        branchName: "feature/service-scripts",
        scriptName: "api",
        daemonPort: 6767,
        daemonListenHost: "127.0.0.1",
      }),
    );
    expect(messages).toContainEqual({
      type: "start_workspace_script_response",
      payload: {
        requestId: "request-script",
        workspaceId: "workspace-1",
        scriptName: "api",
        terminalId: "terminal-1",
        error: null,
      },
    });
  });
});

describe("session pull request timeline handling", () => {
  test("routes GitHub search requests through GitHubService", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      searchIssuesAndPrs: vi.fn().mockResolvedValue({
        githubFeaturesEnabled: true,
        items: [
          {
            kind: "pr",
            number: 42,
            title: "Ship search",
            url: "https://github.com/getpaseo/paseo/pull/42",
            state: "OPEN",
            body: null,
            labels: [],
            baseRefName: "main",
            headRefName: "feature",
            updatedAt: "2026-04-18T13:00:00Z",
          },
        ],
      }),
    };
    const session = createSessionForTest({ github, messages });

    await session.handleMessage({
      type: "github_search_request",
      cwd: "/tmp/repo",
      query: "search",
      limit: 5,
      kinds: ["github-pr"],
      requestId: "request-search",
    });

    expect(github.searchIssuesAndPrs).toHaveBeenCalledWith({
      cwd: "/tmp/repo",
      query: "search",
      limit: 5,
      kinds: ["github-pr"],
    });
    expect(messages).toContainEqual({
      type: "github_search_response",
      payload: {
        items: [
          {
            kind: "pr",
            number: 42,
            title: "Ship search",
            url: "https://github.com/getpaseo/paseo/pull/42",
            state: "OPEN",
            body: null,
            labels: [],
            baseRefName: "main",
            headRefName: "feature",
            updatedAt: "2026-04-18T13:00:00Z",
          },
        ],
        githubFeaturesEnabled: true,
        error: null,
        requestId: "request-search",
      },
    });
  });

  test("passes request identity to GitHubService and emits timeline items", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      isAuthenticated: vi.fn().mockResolvedValue(true),
      getPullRequestTimeline: vi.fn().mockResolvedValue({
        prNumber: 42,
        repoOwner: "getpaseo",
        repoName: "paseo",
        items: [
          {
            id: "review-1",
            kind: "review",
            author: "octocat",
            authorUrl: "https://github.com/octocat",
            body: "Looks good",
            createdAt: 1710000000000,
            url: "https://github.com/getpaseo/paseo/pull/42#pullrequestreview-1",
            reviewState: "approved",
          },
        ],
        truncated: false,
        error: null,
      }),
    };
    const session = createSessionForTest({ github, messages });

    await session.handleMessage({
      type: "pull_request_timeline_request",
      cwd: "/tmp/repo",
      prNumber: 42,
      repoOwner: "getpaseo",
      repoName: "paseo",
      requestId: "request-1",
    });

    expect(github.getPullRequestTimeline).toHaveBeenCalledWith({
      cwd: "/tmp/repo",
      prNumber: 42,
      repoOwner: "getpaseo",
      repoName: "paseo",
    });
    expect(messages).toContainEqual({
      type: "pull_request_timeline_response",
      payload: {
        cwd: "/tmp/repo",
        prNumber: 42,
        items: [
          {
            id: "review-1",
            kind: "review",
            author: "octocat",
            body: "Looks good",
            createdAt: 1710000000000,
            url: "https://github.com/getpaseo/paseo/pull/42#pullrequestreview-1",
            reviewState: "approved",
          },
        ],
        truncated: false,
        error: null,
        requestId: "request-1",
        githubFeaturesEnabled: true,
      },
    });
  });

  test.each([
    { prNumber: 0, repoOwner: "getpaseo", repoName: "paseo" },
    { prNumber: -1, repoOwner: "getpaseo", repoName: "paseo" },
    { prNumber: 42, repoOwner: "get paseo", repoName: "paseo" },
    { prNumber: 42, repoOwner: "getpaseo/cli", repoName: "paseo" },
    { prNumber: 42, repoOwner: "get$paseo", repoName: "paseo" },
    { prNumber: 42, repoOwner: "getpaseo", repoName: "pa seo" },
    { prNumber: 42, repoOwner: "getpaseo", repoName: "paseo/app" },
    { prNumber: 42, repoOwner: "getpaseo", repoName: "paseo!" },
  ])("returns an unknown error when request identity is invalid: %j", async (identity) => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      isAuthenticated: vi.fn().mockResolvedValue(true),
      getPullRequestTimeline: vi.fn(),
    };
    const session = createSessionForTest({ github, messages });

    await session.handleMessage({
      type: "pull_request_timeline_request",
      cwd: "/tmp/repo",
      ...identity,
      requestId: "request-invalid",
    });

    expect(github.isAuthenticated).not.toHaveBeenCalled();
    expect(github.getPullRequestTimeline).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "pull_request_timeline_response",
      payload: {
        cwd: "/tmp/repo",
        prNumber: identity.prNumber,
        items: [],
        truncated: false,
        error: {
          kind: "unknown",
          message: "Pull request timeline request has invalid PR identity",
        },
        requestId: "request-invalid",
        githubFeaturesEnabled: true,
      },
    });
  });

  test("disables GitHub features when gh auth is unavailable", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      isAuthenticated: vi.fn().mockResolvedValue(false),
      getPullRequestTimeline: vi.fn(),
    };
    const session = createSessionForTest({ github, messages });

    await session.handleMessage({
      type: "pull_request_timeline_request",
      cwd: "/tmp/repo",
      prNumber: 42,
      repoOwner: "getpaseo",
      repoName: "paseo",
      requestId: "request-3",
    });

    expect(github.getPullRequestTimeline).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "pull_request_timeline_response",
      payload: {
        cwd: "/tmp/repo",
        prNumber: 42,
        items: [],
        truncated: false,
        error: {
          kind: "unknown",
          message: "GitHub CLI is unavailable or not authenticated",
        },
        requestId: "request-3",
        githubFeaturesEnabled: false,
      },
    });
  });
});
