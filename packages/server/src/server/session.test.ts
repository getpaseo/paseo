import { execSync } from "child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve as resolvePath } from "path";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import {
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "@getpaseo/protocol/binary-frames/index";
import { Session } from "./session.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import { StructuredAgentFallbackError } from "./agent/agent-response-loop.js";
import type { StoredAgentRecord } from "./agent/agent-storage.js";
import type { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import type { SessionOptions } from "./session.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "./messages.js";
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
import type {
  GitHubCheckDetails,
  GitHubPullRequestStatusFacts,
  GitHubService,
} from "../services/github-service.js";

interface SessionHandlerInternals {
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
  handleCheckoutGithubSetAutoMergeRequest(params: unknown): Promise<unknown>;
  handleCheckoutPullRequest(params: unknown): Promise<unknown>;
  handleCheckoutPushRequest(params: unknown): Promise<unknown>;
  handleCheckoutRefreshRequest(params: unknown): Promise<unknown>;
  handleCheckoutStatusRequest(params: unknown): Promise<unknown>;
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
  renameCurrentBranch: vi.fn(),
  resolveBranchCheckout: vi.fn(),
  warmCheckoutShortstatInBackground: vi.fn(),
}));

const agentResponseMocks = vi.hoisted(() => ({
  generateStructuredAgentResponseWithFallback: vi.fn(),
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
    renameCurrentBranch: checkoutGitMocks.renameCurrentBranch,
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

vi.mock("./worktree-bootstrap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./worktree-bootstrap.js")>();
  return {
    ...actual,
    spawnWorkspaceScript: spawnMocks.spawnWorkspaceScript,
  };
});

interface SessionForTestOptions {
  agentManager?: { [K in keyof SessionOptions["agentManager"]]?: unknown };
  agentStorage?: { [K in keyof SessionOptions["agentStorage"]]?: unknown };
  github?: Partial<GitHubService>;
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
  serviceProxy?: SessionOptions["serviceProxy"];
  scriptRuntimeStore?: SessionOptions["scriptRuntimeStore"];
  getDaemonTcpPort?: () => number | null;
  getDaemonTcpHost?: () => string | null;
  providerSnapshotManager?: ProviderSnapshotManager;
  stt?: SessionOptions["stt"];
  voice?: SessionOptions["voice"];
  paseoHome?: string;
  serverId?: SessionOptions["serverId"];
  daemonVersion?: SessionOptions["daemonVersion"];
  daemonRuntimeConfig?: SessionOptions["daemonRuntimeConfig"];
  downloadTokenStore?: SessionOptions["downloadTokenStore"];
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
    downloadTokenStore: options.downloadTokenStore ?? asDownloadTokenStore(),
    pushTokenStore: asPushTokenStore(),
    paseoHome: options.paseoHome ?? "/tmp/paseo-home",
    agentManager: asAgentManager({
      listAgents: vi.fn(() => []),
      subscribe: vi.fn(() => () => {}),
      ...options.agentManager,
    }),
    agentStorage: asAgentStorage({
      list: vi.fn().mockResolvedValue([]),
      ...options.agentStorage,
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
    providerSnapshotManager:
      options.providerSnapshotManager ?? createProviderSnapshotManagerStub().manager,
    serviceProxy: options.serviceProxy,
    scriptRuntimeStore: options.scriptRuntimeStore,
    getDaemonTcpPort: options.getDaemonTcpPort,
    getDaemonTcpHost: options.getDaemonTcpHost,
    voice: options.voice,
    serverId: options.serverId,
    daemonVersion: options.daemonVersion,
    daemonRuntimeConfig: options.daemonRuntimeConfig,
  });
}

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

describe("workspace file access (behavior preservation)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeDir(prefix: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    tempDirs.push(dir);
    return dir;
  }

  function uploadFrame(args: Parameters<typeof encodeFileTransferFrame>[0]): FileTransferFrame {
    const frame = decodeFileTransferFrame(encodeFileTransferFrame(args));
    if (!frame) {
      throw new Error("Expected a file transfer frame");
    }
    return frame;
  }

  test("file_explorer list returns directory entries", async () => {
    const cwd = makeDir("file-access-list-");
    writeFileSync(join(cwd, "a.txt"), "alpha");
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({ messages });

    await session.handleMessage({
      type: "file_explorer_request",
      cwd,
      path: ".",
      mode: "list",
      requestId: "req-list",
    });

    expect(messages).toHaveLength(1);
    const message = messages[0];
    if (message.type !== "file_explorer_response") {
      throw new Error(`expected file_explorer_response, got ${message.type}`);
    }
    expect(message.payload.error).toBeNull();
    expect(message.payload.directory).not.toBeNull();
  });

  test("file_explorer rejects an empty cwd with an error envelope", async () => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({ messages });

    await session.handleMessage({
      type: "file_explorer_request",
      cwd: "   ",
      path: ".",
      mode: "list",
      requestId: "req-empty",
    });

    expect(messages).toEqual([
      {
        type: "file_explorer_response",
        payload: expect.objectContaining({
          error: "cwd is required",
          directory: null,
          file: null,
          requestId: "req-empty",
        }),
      },
    ]);
  });

  test("file_download_token issues a token for a real file", async () => {
    const cwd = makeDir("file-access-token-");
    writeFileSync(join(cwd, "report.txt"), "hello world");
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({
      messages,
      downloadTokenStore: new DownloadTokenStore({ ttlMs: 60_000 }),
    });

    await session.handleMessage({
      type: "file_download_token_request",
      cwd,
      path: "report.txt",
      requestId: "req-token",
    });

    expect(messages).toHaveLength(1);
    const message = messages[0];
    if (message.type !== "file_download_token_response") {
      throw new Error(`expected file_download_token_response, got ${message.type}`);
    }
    expect(message.payload.error).toBeNull();
    expect(typeof message.payload.token).toBe("string");
    expect(message.payload.fileName).toBe("report.txt");
    expect(message.payload.size).toBe(11);
  });

  test("file_download_token rejects an empty cwd with an error envelope", async () => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({ messages });

    await session.handleMessage({
      type: "file_download_token_request",
      cwd: "",
      path: "report.txt",
      requestId: "req-token-empty",
    });

    expect(messages).toEqual([
      {
        type: "file_download_token_response",
        payload: expect.objectContaining({
          token: null,
          error: "cwd is required",
          requestId: "req-token-empty",
        }),
      },
    ]);
  });

  test("project_icon responds for a workspace cwd", async () => {
    const cwd = makeDir("file-access-icon-");
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({ messages });

    await session.handleMessage({
      type: "project_icon_request",
      cwd,
      requestId: "req-icon",
    });

    expect(messages).toHaveLength(1);
    const message = messages[0];
    if (message.type !== "project_icon_response") {
      throw new Error(`expected project_icon_response, got ${message.type}`);
    }
    expect(message.payload.cwd).toBe(cwd);
    expect(message.payload.error).toBeNull();
  });

  test("file upload round-trips bytes through binary frames", async () => {
    const paseoHome = makeDir("file-access-upload-");
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({ messages, paseoHome });

    await session.handleMessage({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-upload",
    });
    await session.handleBinaryFrame({
      kind: "file_transfer",
      frame: uploadFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId: "req-upload",
        metadata: {
          mime: "text/plain",
          size: 11,
          encoding: "binary",
          modifiedAt: "2026-05-02T00:00:00.000Z",
          fileName: "notes.txt",
        },
      }),
    });
    await session.handleBinaryFrame({
      kind: "file_transfer",
      frame: uploadFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId: "req-upload",
        payload: new TextEncoder().encode("hello world"),
      }),
    });
    await session.handleBinaryFrame({
      kind: "file_transfer",
      frame: uploadFrame({
        opcode: FileTransferOpcode.FileEnd,
        requestId: "req-upload",
      }),
    });

    const response = messages.find((message) => message.type === "file.upload.response");
    if (response?.type !== "file.upload.response") {
      throw new Error("expected a file.upload.response message");
    }
    expect(response.payload.error).toBeNull();
    expect(response.payload.file?.fileName).toBe("notes.txt");
    expect(response.payload.file?.size).toBe(11);
  });
});

function createStoredAgentRecord(
  overrides: Pick<StoredAgentRecord, "id" | "cwd"> & Partial<StoredAgentRecord>,
): StoredAgentRecord {
  return {
    id: overrides.id,
    provider: overrides.provider ?? "codex",
    cwd: overrides.cwd,
    workspaceId: overrides.workspaceId,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    lastUserMessageAt: overrides.lastUserMessageAt ?? null,
    title: overrides.title ?? null,
    labels: overrides.labels ?? {},
    lastStatus: overrides.lastStatus ?? "idle",
    lastModeId: overrides.lastModeId ?? null,
    config: overrides.config ?? null,
    runtimeInfo: overrides.runtimeInfo,
    features: overrides.features,
    persistence: overrides.persistence ?? null,
    lastError: overrides.lastError,
    requiresAttention: overrides.requiresAttention,
    attentionReason: overrides.attentionReason,
    attentionTimestamp: overrides.attentionTimestamp,
    internal: overrides.internal,
    archivedAt: overrides.archivedAt ?? null,
  };
}

describe("agent detach RPC", () => {
  test("detaches a stored subagent and emits the updated standalone agent", async () => {
    const messages: unknown[] = [];
    const childBefore = createStoredAgentRecord({
      id: "child-agent",
      cwd: "/tmp/child",
      workspaceId: "workspace-child",
      title: "Child",
      labels: {
        [PARENT_AGENT_ID_LABEL]: "parent-agent",
        topic: "handoff",
      },
    });
    const childAfter = createStoredAgentRecord({
      ...childBefore,
      updatedAt: "2026-01-01T00:00:01.000Z",
      labels: { topic: "handoff" },
    });
    const workspace = {
      workspaceId: "workspace-child",
      projectId: "project-child",
      cwd: "/tmp/child",
      kind: "worktree" as const,
      displayName: "Child workspace",
      title: null,
      branch: "child",
      baseBranch: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
    };
    const project = {
      projectId: "project-child",
      rootPath: "/tmp/child",
      kind: "git" as const,
      displayName: "Project",
      customName: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
    };
    const detachAgent = vi.fn().mockResolvedValue({
      record: childAfter,
      live: false,
      previousParentAgentId: "parent-agent",
    });
    const getAgent = vi.fn(() => null);

    const session = createSessionForTest({
      messages,
      agentManager: {
        getAgent,
        detachAgent,
      },
      agentStorage: {
        list: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue(null),
      },
      workspaceRegistry: {
        get: vi.fn().mockResolvedValue(workspace),
        list: vi.fn().mockResolvedValue([workspace]),
      },
      projectRegistry: {
        get: vi.fn().mockResolvedValue(project),
        list: vi.fn().mockResolvedValue([project]),
      },
    });

    await session.handleMessage({
      type: "fetch_agents_request",
      requestId: "subscribe-agents",
      subscribe: { subscriptionId: "agents-sub" },
    });
    messages.splice(0);

    await session.handleMessage({
      type: "agent.detach.request",
      agentId: childBefore.id,
      requestId: "detach-1",
    });

    expect(detachAgent).toHaveBeenCalledWith("child-agent");
    expect(messages).toContainEqual({
      type: "agent_update",
      payload: {
        kind: "upsert",
        agent: expect.objectContaining({
          id: "child-agent",
          labels: { topic: "handoff" },
          workspaceId: "workspace-child",
        }),
        project: expect.objectContaining({
          projectKey: "project-child",
          workspaceName: "Child workspace",
        }),
      },
    });
    expect(messages).toContainEqual({
      type: "agent.detach.response",
      payload: {
        requestId: "detach-1",
        agentId: "child-agent",
        accepted: true,
        error: null,
      },
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

describe("daemon status + pairing RPC", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeHome(): string {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "daemon-session-test-")));
    tempDirs.push(home);
    return home;
  }

  test("daemon.get_status.request reports identity, runtime config, and mapped providers", async () => {
    const messages: unknown[] = [];
    const session = createSessionForTest({
      messages,
      paseoHome: makeHome(),
      serverId: "srv-test",
      daemonVersion: "9.9.9",
      daemonRuntimeConfig: { listen: "127.0.0.1:6767", relay: null },
      agentManager: {
        listProviderAvailability: vi.fn().mockResolvedValue([
          { provider: "claude", available: true },
          { provider: "codex", available: false, error: "boom" },
        ]),
      },
    });

    await session.handleMessage({ type: "daemon.get_status.request", requestId: "status-1" });

    expect(messages).toEqual([
      {
        type: "daemon.get_status.response",
        payload: {
          requestId: "status-1",
          serverId: "srv-test",
          version: "9.9.9",
          pid: process.pid,
          nodePath: process.execPath,
          startedAt: null,
          listen: "127.0.0.1:6767",
          relay: null,
          providers: [
            { provider: "claude", available: true, error: null },
            { provider: "codex", available: false, error: "boom" },
          ],
        },
      },
    ]);
  });

  test("daemon.get_status.request falls back to a null/empty status when provider listing fails", async () => {
    const messages: unknown[] = [];
    const session = createSessionForTest({
      messages,
      paseoHome: makeHome(),
      serverId: "srv-test",
      daemonVersion: "9.9.9",
      daemonRuntimeConfig: { listen: "127.0.0.1:6767", relay: null },
      agentManager: {
        listProviderAvailability: vi.fn().mockRejectedValue(new Error("provider listing failed")),
      },
    });

    await session.handleMessage({
      type: "daemon.get_status.request",
      requestId: "status-fallback-1",
    });

    expect(messages).toEqual([
      {
        type: "daemon.get_status.response",
        payload: {
          requestId: "status-fallback-1",
          serverId: "srv-test",
          version: "9.9.9",
          pid: process.pid,
          nodePath: process.execPath,
          startedAt: null,
          listen: null,
          relay: null,
          providers: [],
        },
      },
    ]);
  });

  test("daemon.get_pairing_offer.request returns an empty offer when relay is disabled", async () => {
    const messages: unknown[] = [];
    const session = createSessionForTest({
      messages,
      paseoHome: makeHome(),
      daemonRuntimeConfig: {
        listen: "127.0.0.1:6767",
        relay: {
          enabled: false,
          endpoint: "relay.paseo.sh:443",
          publicEndpoint: "relay.paseo.sh:443",
          useTls: true,
          publicUseTls: true,
        },
      },
    });

    await session.handleMessage({
      type: "daemon.get_pairing_offer.request",
      requestId: "pairing-1",
    });

    expect(messages).toEqual([
      {
        type: "daemon.get_pairing_offer.response",
        payload: {
          requestId: "pairing-1",
          url: "",
          qr: null,
          relayEnabled: false,
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

function createTerminalManagerStub(options?: { setTerminalTitle?: ReturnType<typeof vi.fn> }): {
  setTerminalTitle: ReturnType<typeof vi.fn>;
  subscribeTerminalsChanged: ReturnType<typeof vi.fn>;
  subscribeTerminalWorkspaceContributionChanged: ReturnType<typeof vi.fn>;
} {
  return {
    setTerminalTitle: options?.setTerminalTitle ?? vi.fn(),
    subscribeTerminalsChanged: vi.fn(() => () => {}),
    subscribeTerminalWorkspaceContributionChanged: vi.fn(() => () => {}),
  };
}

afterEach(() => {
  vi.clearAllMocks();
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

  test("get_providers_snapshot_request forwards cwd to the provider authority", async () => {
    const messages: unknown[] = [];
    const workspaceCwd = resolvePath("/tmp/session-provider-snapshot");
    const { manager: providerSnapshotManager, getSnapshot } = createProviderSnapshotManagerStub();
    const session = createSessionForTest({ messages, providerSnapshotManager });

    await session.handleMessage({
      type: "get_providers_snapshot_request",
      cwd: workspaceCwd,
      requestId: "snapshot-workspace",
    });

    expect(getSnapshot).toHaveBeenCalledWith(workspaceCwd);
  });

  test("normalizes legacy model and mode list requests without cwd to home", async () => {
    const messages: unknown[] = [];
    const {
      manager: providerSnapshotManager,
      getSnapshot,
      warmUpSnapshotForCwd,
    } = createProviderSnapshotManagerStub();
    getSnapshot.mockReturnValue([
      {
        provider: "codex",
        status: "loading",
        enabled: true,
      },
    ]);
    const session = createSessionForTest({ messages, providerSnapshotManager });

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

    expect(getSnapshot).toHaveBeenCalledWith(homedir());
    expect(warmUpSnapshotForCwd).toHaveBeenCalledWith({
      cwd: homedir(),
      providers: ["codex"],
    });
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

  test("list_provider_models_request awaits warmup and emits ready models", async () => {
    const messages: unknown[] = [];
    const warmupDeferred = deferred<void>();
    const {
      manager: providerSnapshotManager,
      getSnapshot,
      warmUpSnapshotForCwd,
    } = createProviderSnapshotManagerStub();
    getSnapshot.mockReturnValueOnce([
      {
        provider: "codex",
        status: "loading",
        enabled: true,
      },
    ]);
    getSnapshot.mockReturnValue([
      {
        provider: "codex",
        status: "ready",
        enabled: true,
        models: [{ provider: "codex", id: "gpt-5.4", label: "GPT-5.4" }],
        modes: [],
        fetchedAt: "2026-05-28T00:00:00.000Z",
      },
    ]);
    warmUpSnapshotForCwd.mockReturnValue(warmupDeferred.promise);
    const session = createSessionForTest({ messages, providerSnapshotManager });

    const responsePromise = session.handleMessage({
      type: "list_provider_models_request",
      provider: "codex",
      requestId: "models-loading-home",
    });

    expect(warmUpSnapshotForCwd).toHaveBeenCalledWith({
      cwd: homedir(),
      providers: ["codex"],
    });
    warmupDeferred.resolve();
    await responsePromise;

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
        fetchedAt: "2026-05-28T00:00:00.000Z",
        requestId: "models-loading-home",
      },
    });
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

    await session.handleMessage({
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

    await session.handleMessage({
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

    await session.handleMessage({
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

Concise, imperative mood, no trailing period.

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

    await session.handleMessage({
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

    await session.handleMessage({
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

    await session.handleMessage({
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
  ])("renders the default commit style when no override applies (%s)", async (_name, config) => {
    const prompt = await generateCommitPromptWithConfig(config);

    expect(prompt).toBe(PRE_CHANGE_COMMIT_PROMPT);
  });

  test("commit instructions replace the default commit style", async () => {
    const prompt = await generateCommitPromptWithConfig({
      metadataGeneration: {
        commitMessage: {
          instructions: "Use conventional commits.\nAccept XML-ish <scope> text.",
        },
      },
    });

    expect(prompt).toContain("Use conventional commits.\nAccept XML-ish <scope> text.");
    expect(prompt).not.toContain("Concise, imperative mood, no trailing period.");

    const contractIndex = prompt.indexOf("Write a concise git commit message");
    const styleIndex = prompt.indexOf("Use conventional commits.");
    const jsonContractIndex = prompt.indexOf("Return JSON only");
    const fileListIndex = prompt.indexOf("Files changed:");
    const patchIndex = prompt.indexOf("diff --git");

    expect(contractIndex).toBeGreaterThanOrEqual(0);
    expect(contractIndex).toBeLessThan(styleIndex);
    expect(styleIndex).toBeLessThan(jsonContractIndex);
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

    await session.handleMessage({
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

    await session.handleMessage({
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

Clear, descriptive title; body explaining what changed and why.

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

    await session.handleMessage({
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

    await session.handleMessage({
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
  ])("renders the default PR style when no override applies (%s)", async (_name, config) => {
    const prompt = await generatePullRequestPromptWithConfig(config);

    expect(prompt).toBe(PRE_CHANGE_PULL_REQUEST_PROMPT);
  });

  test("PR instructions replace the default PR style", async () => {
    const prompt = await generatePullRequestPromptWithConfig({
      metadataGeneration: {
        pullRequest: {
          instructions: "Use a terse title.\nKeep literal <ticket> text.",
        },
      },
    });

    expect(prompt).toContain("Use a terse title.\nKeep literal <ticket> text.");
    expect(prompt).not.toContain("Clear, descriptive title; body explaining what changed and why.");

    const contractIndex = prompt.indexOf("Write a pull request title and body");
    const styleIndex = prompt.indexOf("Use a terse title.");
    const jsonContractIndex = prompt.indexOf("Return JSON only");
    const fileListIndex = prompt.indexOf("Files changed:");
    const patchIndex = prompt.indexOf("diff --git");

    expect(contractIndex).toBeGreaterThanOrEqual(0);
    expect(contractIndex).toBeLessThan(styleIndex);
    expect(styleIndex).toBeLessThan(jsonContractIndex);
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

    await session.handleMessage({
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

    await session.handleMessage({
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
            github: {
              mergeStateStatus: "CLEAN",
              autoMergeRequest: null,
              viewerCanEnableAutoMerge: false,
              viewerCanDisableAutoMerge: false,
              viewerCanMergeAsAdmin: false,
              viewerCanUpdateBranch: false,
              repository: {
                autoMergeAllowed: true,
                mergeCommitAllowed: true,
                squashMergeAllowed: true,
                rebaseMergeAllowed: true,
                viewerDefaultMergeMethod: "SQUASH",
              },
              isMergeQueueEnabled: false,
              isInMergeQueue: false,
            },
          },
        },
      }),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout_pr_merge_request",
      cwd: "/tmp/request-worktree",
      mergeMethod: "squash",
      requestId: "request-pr-merge",
    });

    expect(github.mergePullRequest).toHaveBeenCalledWith({
      cwd: "/tmp/request-worktree",
      prNumber: 42,
      mergeMethod: "squash",
      status: {
        number: 42,
        github: {
          mergeStateStatus: "CLEAN",
          autoMergeRequest: null,
          viewerCanEnableAutoMerge: false,
          viewerCanDisableAutoMerge: false,
          viewerCanMergeAsAdmin: false,
          viewerCanUpdateBranch: false,
          repository: {
            autoMergeAllowed: true,
            mergeCommitAllowed: true,
            squashMergeAllowed: true,
            rebaseMergeAllowed: true,
            viewerDefaultMergeMethod: "SQUASH",
          },
          isMergeQueueEnabled: false,
          isInMergeQueue: false,
        },
      },
    });
    expect(workspaceGitService.getSnapshot).toHaveBeenNthCalledWith(1, "/tmp/request-worktree", {
      force: true,
      includeGitHub: true,
      reason: "merge-pr-validation",
    });
    expect(workspaceGitService.getSnapshot).toHaveBeenNthCalledWith(2, "/tmp/request-worktree", {
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

  test("rejects direct merge when fresh GitHub facts block a warm clean snapshot", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      mergePullRequest: vi.fn(
        async (input: { status?: { github?: { mergeStateStatus?: string | null } } }) => {
          if (input.status?.github?.mergeStateStatus === "BLOCKED") {
            throw new Error("GitHub does not report this pull request as ready for direct merge");
          }
          return { success: true };
        },
      ),
    };
    const createSnapshot = (mergeStateStatus: "CLEAN" | "BLOCKED") => ({
      github: {
        pullRequest: {
          number: 42,
          github: {
            mergeStateStatus,
            autoMergeRequest: null,
            viewerCanEnableAutoMerge: false,
            viewerCanDisableAutoMerge: false,
            viewerCanMergeAsAdmin: false,
            viewerCanUpdateBranch: false,
            repository: {
              autoMergeAllowed: true,
              mergeCommitAllowed: true,
              squashMergeAllowed: true,
              rebaseMergeAllowed: true,
              viewerDefaultMergeMethod: "SQUASH",
            },
            isMergeQueueEnabled: false,
            isInMergeQueue: false,
          },
        },
      },
    });
    const workspaceGitService = {
      getSnapshot: vi.fn(async (_cwd: string, options?: { force?: boolean }) =>
        createSnapshot(options?.force ? "BLOCKED" : "CLEAN"),
      ),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout_pr_merge_request",
      cwd: "/tmp/request-worktree",
      mergeMethod: "squash",
      requestId: "request-pr-merge-fresh-blocked",
    });

    expect(workspaceGitService.getSnapshot).toHaveBeenCalledTimes(1);
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/request-worktree", {
      force: true,
      includeGitHub: true,
      reason: "merge-pr-validation",
    });
    expect(github.mergePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        status: expect.objectContaining({
          github: expect.objectContaining({ mergeStateStatus: "BLOCKED" }),
        }),
      }),
    );
    expect(github.invalidate).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "checkout_pr_merge_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: false,
        error: {
          code: "UNKNOWN",
          message: "GitHub does not report this pull request as ready for direct merge",
        },
        requestId: "request-pr-merge-fresh-blocked",
      },
    });
  });

  test("rejects direct merge when the current pull request is missing GitHub merge facts", async () => {
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
            mergeable: "MERGEABLE",
          },
        },
      }),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout_pr_merge_request",
      cwd: "/tmp/request-worktree",
      mergeMethod: "squash",
      requestId: "request-pr-merge-missing-github-facts",
    });

    expect(github.mergePullRequest).not.toHaveBeenCalled();
    expect(github.invalidate).not.toHaveBeenCalled();
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/request-worktree", {
      force: true,
      includeGitHub: true,
      reason: "merge-pr-validation",
    });
    expect(messages).toContainEqual({
      type: "checkout_pr_merge_response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: false,
        error: {
          code: "UNKNOWN",
          message: "GitHub merge facts are unavailable for this pull request",
        },
        requestId: "request-pr-merge-missing-github-facts",
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
            github: {
              mergeStateStatus: "CLEAN",
              autoMergeRequest: null,
              viewerCanEnableAutoMerge: false,
              viewerCanDisableAutoMerge: false,
              viewerCanMergeAsAdmin: false,
              viewerCanUpdateBranch: false,
              repository: {
                autoMergeAllowed: true,
                mergeCommitAllowed: true,
                squashMergeAllowed: true,
                rebaseMergeAllowed: true,
                viewerDefaultMergeMethod: "SQUASH",
              },
              isMergeQueueEnabled: false,
              isInMergeQueue: false,
            },
          },
        },
      }),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await session.handleMessage({
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

describe("session checkout pull request auto-merge", () => {
  const autoMergeGithubFacts = (
    overrides: Partial<GitHubPullRequestStatusFacts> = {},
  ): GitHubPullRequestStatusFacts => ({
    mergeStateStatus: "BLOCKED",
    autoMergeRequest: null,
    viewerCanEnableAutoMerge: true,
    viewerCanDisableAutoMerge: false,
    viewerCanMergeAsAdmin: false,
    viewerCanUpdateBranch: false,
    repository: {
      autoMergeAllowed: true,
      mergeCommitAllowed: true,
      squashMergeAllowed: true,
      rebaseMergeAllowed: true,
      viewerDefaultMergeMethod: "SQUASH",
    },
    isMergeQueueEnabled: false,
    isInMergeQueue: false,
    ...overrides,
  });

  test("enables auto-merge for the current pull request and refreshes GitHub state", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      enablePullRequestAutoMerge: vi.fn().mockResolvedValue({ success: true }),
    };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue({
        github: {
          pullRequest: {
            number: 42,
            mergeable: "MERGEABLE",
            github: autoMergeGithubFacts(),
          },
        },
      }),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout.github.set_auto_merge.request",
      cwd: "/tmp/request-worktree",
      enabled: true,
      mergeMethod: "squash",
      requestId: "request-pr-auto-merge-enable",
    });

    expect(github.enablePullRequestAutoMerge).toHaveBeenCalledWith({
      cwd: "/tmp/request-worktree",
      prNumber: 42,
      mergeMethod: "squash",
      status: {
        number: 42,
        mergeable: "MERGEABLE",
        github: autoMergeGithubFacts(),
      },
    });
    expect(workspaceGitService.getSnapshot).toHaveBeenNthCalledWith(1, "/tmp/request-worktree", {
      force: true,
      includeGitHub: true,
      reason: "auto-merge-validation",
    });
    expect(workspaceGitService.getSnapshot).toHaveBeenNthCalledWith(2, "/tmp/request-worktree", {
      force: true,
      reason: "enable-pr-auto-merge",
    });
    expect(github.invalidate).toHaveBeenCalledWith({ cwd: "/tmp/request-worktree" });
    expect(messages).toContainEqual({
      type: "checkout.github.set_auto_merge.response",
      payload: {
        cwd: "/tmp/request-worktree",
        enabled: true,
        success: true,
        error: null,
        requestId: "request-pr-auto-merge-enable",
      },
    });
  });

  test("disables auto-merge for the current pull request and refreshes GitHub state", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      disablePullRequestAutoMerge: vi.fn().mockResolvedValue({ success: true }),
    };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue({
        github: {
          pullRequest: {
            number: 42,
            github: autoMergeGithubFacts({
              autoMergeRequest: {
                enabledAt: "2026-05-13T17:00:00Z",
                mergeMethod: "SQUASH",
                enabledBy: "moboudra",
              },
              viewerCanEnableAutoMerge: false,
              viewerCanDisableAutoMerge: true,
            }),
          },
        },
      }),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout.github.set_auto_merge.request",
      cwd: "/tmp/request-worktree",
      enabled: false,
      requestId: "request-pr-auto-merge-disable",
    });

    expect(github.disablePullRequestAutoMerge).toHaveBeenCalledWith({
      cwd: "/tmp/request-worktree",
      prNumber: 42,
      status: {
        number: 42,
        github: autoMergeGithubFacts({
          autoMergeRequest: {
            enabledAt: "2026-05-13T17:00:00Z",
            mergeMethod: "SQUASH",
            enabledBy: "moboudra",
          },
          viewerCanEnableAutoMerge: false,
          viewerCanDisableAutoMerge: true,
        }),
      },
    });
    expect(workspaceGitService.getSnapshot).toHaveBeenNthCalledWith(1, "/tmp/request-worktree", {
      force: true,
      includeGitHub: true,
      reason: "auto-merge-validation",
    });
    expect(workspaceGitService.getSnapshot).toHaveBeenNthCalledWith(2, "/tmp/request-worktree", {
      force: true,
      reason: "disable-pr-auto-merge",
    });
    expect(github.invalidate).toHaveBeenCalledWith({ cwd: "/tmp/request-worktree" });
    expect(messages).toContainEqual({
      type: "checkout.github.set_auto_merge.response",
      payload: {
        cwd: "/tmp/request-worktree",
        enabled: false,
        success: true,
        error: null,
        requestId: "request-pr-auto-merge-disable",
      },
    });
  });

  test("surfaces auto-merge errors verbatim", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      enablePullRequestAutoMerge: vi.fn().mockRejectedValue(new Error("auto-merge is disabled")),
    };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue({
        github: {
          pullRequest: {
            number: 42,
            github: autoMergeGithubFacts(),
          },
        },
      }),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout.github.set_auto_merge.request",
      cwd: "/tmp/request-worktree",
      enabled: true,
      mergeMethod: "merge",
      requestId: "request-pr-auto-merge-failure",
    });

    expect(messages).toContainEqual({
      type: "checkout.github.set_auto_merge.response",
      payload: {
        cwd: "/tmp/request-worktree",
        enabled: true,
        success: false,
        error: {
          code: "UNKNOWN",
          message: "auto-merge is disabled",
        },
        requestId: "request-pr-auto-merge-failure",
      },
    });
  });

  test("rejects auto-merge enable when the requested method is disabled", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      enablePullRequestAutoMerge: vi.fn().mockResolvedValue({ success: true }),
    };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue({
        github: {
          pullRequest: {
            number: 42,
            github: autoMergeGithubFacts({
              repository: {
                autoMergeAllowed: true,
                mergeCommitAllowed: true,
                squashMergeAllowed: false,
                rebaseMergeAllowed: true,
                viewerDefaultMergeMethod: "MERGE",
              },
            }),
          },
        },
      }),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout.github.set_auto_merge.request",
      cwd: "/tmp/request-worktree",
      enabled: true,
      mergeMethod: "squash",
      requestId: "request-pr-auto-merge-method-disabled",
    });

    expect(github.enablePullRequestAutoMerge).not.toHaveBeenCalled();
    expect(github.invalidate).not.toHaveBeenCalled();
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/request-worktree", {
      force: true,
      includeGitHub: true,
      reason: "auto-merge-validation",
    });
    expect(messages).toContainEqual({
      type: "checkout.github.set_auto_merge.response",
      payload: {
        cwd: "/tmp/request-worktree",
        enabled: true,
        success: false,
        error: {
          code: "UNKNOWN",
          message: "Auto-merge is not available because squash is disabled",
        },
        requestId: "request-pr-auto-merge-method-disabled",
      },
    });
  });

  test("rejects auto-merge disable when the viewer cannot disable it", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      disablePullRequestAutoMerge: vi.fn().mockResolvedValue({ success: true }),
    };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue({
        github: {
          pullRequest: {
            number: 42,
            github: autoMergeGithubFacts({
              autoMergeRequest: {
                enabledAt: "2026-05-13T17:00:00Z",
                mergeMethod: "SQUASH",
                enabledBy: "someone-else",
              },
              viewerCanEnableAutoMerge: false,
              viewerCanDisableAutoMerge: false,
            }),
          },
        },
      }),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout.github.set_auto_merge.request",
      cwd: "/tmp/request-worktree",
      enabled: false,
      requestId: "request-pr-auto-merge-disable-forbidden",
    });

    expect(github.disablePullRequestAutoMerge).not.toHaveBeenCalled();
    expect(github.invalidate).not.toHaveBeenCalled();
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/request-worktree", {
      force: true,
      includeGitHub: true,
      reason: "auto-merge-validation",
    });
    expect(messages).toContainEqual({
      type: "checkout.github.set_auto_merge.response",
      payload: {
        cwd: "/tmp/request-worktree",
        enabled: false,
        success: false,
        error: {
          code: "UNKNOWN",
          message: "GitHub does not allow this viewer to disable auto-merge",
        },
        requestId: "request-pr-auto-merge-disable-forbidden",
      },
    });
  });

  test("rejects auto-merge disable requests that include a merge method", async () => {
    const messages: unknown[] = [];
    const github = {
      invalidate: vi.fn(),
      disablePullRequestAutoMerge: vi.fn().mockResolvedValue({ success: true }),
    };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue({
        github: {
          pullRequest: {
            number: 42,
            github: autoMergeGithubFacts({
              autoMergeRequest: {
                enabledAt: "2026-05-13T17:00:00Z",
                mergeMethod: "SQUASH",
                enabledBy: "moboudra",
              },
              viewerCanEnableAutoMerge: false,
              viewerCanDisableAutoMerge: true,
            }),
          },
        },
      }),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout.github.set_auto_merge.request",
      cwd: "/tmp/request-worktree",
      enabled: false,
      mergeMethod: "squash",
      requestId: "request-pr-auto-merge-disable-with-method",
    });

    expect(github.disablePullRequestAutoMerge).not.toHaveBeenCalled();
    expect(github.invalidate).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "checkout.github.set_auto_merge.response",
      payload: {
        cwd: "/tmp/request-worktree",
        enabled: false,
        success: false,
        error: {
          code: "UNKNOWN",
          message: "mergeMethod is not allowed when disabling auto-merge",
        },
        requestId: "request-pr-auto-merge-disable-with-method",
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

    await session.handleMessage({
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

    await session.handleMessage({
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

describe("session checkout refresh handling", () => {
  test("forces a git, GitHub, and diff refresh on demand", async () => {
    const messages: unknown[] = [];
    const github = { invalidate: vi.fn() };
    const workspaceGitService = { getSnapshot: vi.fn().mockResolvedValue({}) };
    const checkoutDiffManager = { scheduleRefreshForCwd: vi.fn() };
    const session = createSessionForTest({
      github,
      workspaceGitService,
      checkoutDiffManager,
      messages,
    });

    await session.handleMessage({
      type: "checkout.refresh.request",
      cwd: "/tmp/request-worktree",
      requestId: "request-refresh",
    });

    expect(github.invalidate).toHaveBeenCalledWith({ cwd: "/tmp/request-worktree" });
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/request-worktree", {
      force: true,
      includeGitHub: true,
      reason: "manual-refresh",
    });
    expect(checkoutDiffManager.scheduleRefreshForCwd).toHaveBeenCalledWith("/tmp/request-worktree");
    expect(messages).toContainEqual({
      type: "checkout.refresh.response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: true,
        error: null,
        requestId: "request-refresh",
      },
    });
  });

  test("reports an error when the snapshot refresh fails", async () => {
    const messages: unknown[] = [];
    const github = { invalidate: vi.fn() };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockRejectedValue(new Error("not a git repository")),
    };
    const checkoutDiffManager = { scheduleRefreshForCwd: vi.fn() };
    const session = createSessionForTest({
      github,
      workspaceGitService,
      checkoutDiffManager,
      messages,
    });

    await session.handleMessage({
      type: "checkout.refresh.request",
      cwd: "/tmp/request-worktree",
      requestId: "request-refresh-error",
    });

    expect(checkoutDiffManager.scheduleRefreshForCwd).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "checkout.refresh.response",
      payload: {
        cwd: "/tmp/request-worktree",
        success: false,
        error: { code: "UNKNOWN", message: "not a git repository" },
        requestId: "request-refresh-error",
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

    await session.handleMessage({
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

    await session.handleMessage({
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
      branch: "app",
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
            project: expect.objectContaining({
              projectKey: "remote:github.com/acme/app",
              projectName: "acme/app",
              workspaceName: "app",
              checkout: expect.objectContaining({
                cwd: "/repo/app",
                isGit: true,
                currentBranch: "app",
                remoteUrl: null,
                worktreeRoot: "/repo/app",
                isPaseoOwnedWorktree: false,
                mainRepoRoot: null,
              }),
            }),
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
      branch: "local",
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
            project: expect.objectContaining({
              projectKey: "/repo/local",
              projectName: "local",
              workspaceName: "local",
              checkout: expect.objectContaining({
                cwd: "/repo/local",
                isGit: true,
                currentBranch: "local",
                remoteUrl: null,
                worktreeRoot: "/repo/local",
                isPaseoOwnedWorktree: false,
                mainRepoRoot: null,
              }),
            }),
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

    await session.handleMessage({
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

    await session.handleMessage({
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

describe("session checkout rename branch handling", () => {
  test("rejects invalid branch slugs without renaming", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = {
      getSnapshot: vi.fn(),
      peekSnapshot: vi.fn(),
    };
    const session = createSessionForTest({ workspaceGitService, messages });

    await session.handleMessage({
      type: "checkout.rename_branch.request",
      cwd: "/tmp/repo",
      branch: "Feature Name",
      requestId: "request-rename-invalid",
    });

    expect(checkoutGitMocks.renameCurrentBranch).not.toHaveBeenCalled();
    expect(workspaceGitService.getSnapshot).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "checkout.rename_branch.response",
      payload: {
        cwd: "/tmp/repo",
        success: false,
        currentBranch: null,
        error: {
          code: "UNKNOWN",
          message:
            "Branch name must contain only lowercase letters, numbers, hyphens, and forward slashes",
        },
        requestId: "request-rename-invalid",
      },
    });
  });

  test("reports null current branch when branch rename fails", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = {
      getSnapshot: vi.fn(),
      peekSnapshot: vi.fn(),
    };
    const session = createSessionForTest({ workspaceGitService, messages });
    checkoutGitMocks.renameCurrentBranch.mockRejectedValue(new Error("branch already exists"));

    await session.handleMessage({
      type: "checkout.rename_branch.request",
      cwd: "/tmp/repo",
      branch: "feature/new-name",
      requestId: "request-rename-failure",
    });

    expect(checkoutGitMocks.renameCurrentBranch).toHaveBeenCalledWith(
      "/tmp/repo",
      "feature/new-name",
    );
    expect(workspaceGitService.peekSnapshot).not.toHaveBeenCalled();
    expect(workspaceGitService.getSnapshot).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "checkout.rename_branch.response",
      payload: {
        cwd: "/tmp/repo",
        success: false,
        currentBranch: null,
        error: {
          code: "UNKNOWN",
          message: "branch already exists",
        },
        requestId: "request-rename-failure",
      },
    });
  });

  test("forces workspace git refresh after renaming the current branch", async () => {
    const messages: unknown[] = [];
    const github = { invalidate: vi.fn() };
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue(
        createWorkspaceGitSnapshot("/tmp/repo", {
          git: {
            currentBranch: "feature/new-name",
            isDirty: false,
          },
        }),
      ),
      peekSnapshot: vi.fn(() =>
        createWorkspaceGitSnapshot("/tmp/repo", {
          git: { currentBranch: "feature/old-name" },
        }),
      ),
    };
    const session = createSessionForTest({ github, workspaceGitService, messages });
    checkoutGitMocks.renameCurrentBranch.mockResolvedValue({
      previousBranch: "feature/old-name",
      currentBranch: "feature/new-name",
    });

    await session.handleMessage({
      type: "checkout.rename_branch.request",
      cwd: "/tmp/repo",
      branch: "feature/new-name",
      requestId: "request-rename-success",
    });

    expect(checkoutGitMocks.renameCurrentBranch).toHaveBeenCalledWith(
      "/tmp/repo",
      "feature/new-name",
    );
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/repo", {
      force: true,
      reason: "rename-branch",
    });
    expect(github.invalidate).toHaveBeenCalledWith({ cwd: "/tmp/repo" });
    expect(messages).toContainEqual({
      type: "checkout.rename_branch.response",
      payload: {
        cwd: "/tmp/repo",
        success: true,
        currentBranch: "feature/new-name",
        error: null,
        requestId: "request-rename-success",
      },
    });
  });
});

describe("session terminal rename handling", () => {
  test("rejects an empty terminal title without calling the terminal manager", async () => {
    const messages: unknown[] = [];
    const terminalManager = createTerminalManagerStub();
    const session = createSessionForTest({ terminalManager, messages });

    await session.handleMessage({
      type: "terminal.rename.request",
      terminalId: "terminal-1",
      title: "   ",
      requestId: "request-empty-title",
    });

    expect(terminalManager.setTerminalTitle).not.toHaveBeenCalled();
    expect(messages).toContainEqual({
      type: "terminal.rename.response",
      payload: {
        requestId: "request-empty-title",
        success: false,
        error: "Title is required",
      },
    });
  });

  test("reports when the terminal manager cannot find the terminal", async () => {
    const messages: unknown[] = [];
    const terminalManager = createTerminalManagerStub({
      setTerminalTitle: vi.fn(() => false),
    });
    const session = createSessionForTest({ terminalManager, messages });

    await session.handleMessage({
      type: "terminal.rename.request",
      terminalId: "missing-terminal",
      title: "Renamed terminal",
      requestId: "request-missing-terminal",
    });

    expect(terminalManager.setTerminalTitle).toHaveBeenCalledWith(
      "missing-terminal",
      "Renamed terminal",
    );
    expect(messages).toContainEqual({
      type: "terminal.rename.response",
      payload: {
        requestId: "request-missing-terminal",
        success: false,
        error: "Terminal not found",
      },
    });
  });

  test("trims and sets a valid terminal title", async () => {
    const messages: unknown[] = [];
    const terminalManager = createTerminalManagerStub({
      setTerminalTitle: vi.fn(() => true),
    });
    const session = createSessionForTest({ terminalManager, messages });

    await session.handleMessage({
      type: "terminal.rename.request",
      terminalId: "terminal-1",
      title: "  Renamed terminal  ",
      requestId: "request-title-success",
    });

    expect(terminalManager.setTerminalTitle).toHaveBeenCalledWith("terminal-1", "Renamed terminal");
    expect(messages).toContainEqual({
      type: "terminal.rename.response",
      payload: {
        requestId: "request-title-success",
        success: true,
        error: null,
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

    await session.handleMessage({
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

    await session.handleMessage({
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

    await session.handleMessage({
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

    await session.handleMessage({
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
      terminalManager: {
        subscribeTerminalsChanged: vi.fn(() => () => {}),
        subscribeTerminalWorkspaceContributionChanged: vi.fn(() => () => {}),
      },
      serviceProxy: { listRoutesForWorkspace: vi.fn(() => []) },
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
            avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
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
            authorUrl: "https://github.com/octocat",
            avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
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

  test("emits GitHub check details responses", async () => {
    const messages: unknown[] = [];
    const checkDetailRequests: Array<{
      cwd: string;
      repoOwner: string;
      repoName: string;
      checkRunId: number;
      workflowRunId?: number;
    }> = [];
    const checkDetails: GitHubCheckDetails = {
      checkRunId: 12345,
      workflowRunId: 456,
      name: "server-tests",
      status: "completed",
      conclusion: "failure",
      url: "https://github.com/getpaseo/paseo/actions/runs/456/job/789",
      detailsUrl: "https://github.com/getpaseo/paseo/actions/runs/456/job/789",
      output: { title: "Tests failed", summary: "1 failure", text: "Assertion failed" },
      annotations: [],
      failedJobs: [],
      truncated: false,
    };
    const github: Partial<GitHubService> = {
      invalidate() {},
      async isAuthenticated() {
        return true;
      },
      async getGitHubCheckDetails(request) {
        checkDetailRequests.push({
          cwd: request.cwd,
          repoOwner: request.repoOwner,
          repoName: request.repoName,
          checkRunId: request.checkRunId,
          workflowRunId: request.workflowRunId,
        });
        return checkDetails;
      },
    };
    const session = createSessionForTest({ github, messages });

    await session.handleMessage({
      type: "checkout.github.get_check_details.request",
      cwd: "/tmp/repo",
      repoOwner: "getpaseo",
      repoName: "paseo",
      checkRunId: 12345,
      workflowRunId: 456,
      requestId: "request-check-details",
    });

    expect(checkDetailRequests).toEqual([
      {
        cwd: "/tmp/repo",
        repoOwner: "getpaseo",
        repoName: "paseo",
        checkRunId: 12345,
        workflowRunId: 456,
      },
    ]);

    expect(messages).toContainEqual({
      type: "checkout.github.get_check_details.response",
      payload: {
        cwd: "/tmp/repo",
        success: true,
        details: {
          checkRunId: 12345,
          workflowRunId: 456,
          name: "server-tests",
          status: "completed",
          conclusion: "failure",
          url: "https://github.com/getpaseo/paseo/actions/runs/456/job/789",
          detailsUrl: "https://github.com/getpaseo/paseo/actions/runs/456/job/789",
          output: { title: "Tests failed", summary: "1 failure", text: "Assertion failed" },
          annotations: [],
          failedJobs: [],
          truncated: false,
        },
        error: null,
        requestId: "request-check-details",
      },
    });
  });
});

describe("chat/schedule/loop dispatch routing (behavior preservation)", () => {
  // Each chat/*, loop/*, and schedule/* type must reach its domain handler. The
  // injected service stubs are unstubbed, so every handler's own try/catch fires
  // and emits its domain rpc_error code — proving the message routed (a dropped
  // case would silently no-op and emit nothing). schedule/* historically routed
  // via the chat dispatcher's fall-through arm; this guards that path explicitly.
  // handleMessage receives already-parsed messages, so these fixtures only need to
  // satisfy the TS union here — zod parsing happens upstream at the transport.
  const routingCases: Array<{ msg: SessionInboundMessage; code: string }> = [
    {
      msg: { type: "chat/create", requestId: "rt-chat-create", name: "room" },
      code: "chat_request_failed",
    },
    { msg: { type: "chat/list", requestId: "rt-chat-list" }, code: "chat_request_failed" },
    {
      msg: { type: "chat/inspect", requestId: "rt-chat-inspect", room: "room" },
      code: "chat_request_failed",
    },
    {
      msg: { type: "chat/delete", requestId: "rt-chat-delete", room: "room" },
      code: "chat_request_failed",
    },
    {
      msg: { type: "chat/post", requestId: "rt-chat-post", room: "room", body: "hi" },
      code: "chat_request_failed",
    },
    {
      msg: { type: "chat/read", requestId: "rt-chat-read", room: "room" },
      code: "chat_request_failed",
    },
    {
      msg: { type: "chat/wait", requestId: "rt-chat-wait", room: "room" },
      code: "chat_request_failed",
    },
    {
      msg: { type: "loop/run", requestId: "rt-loop-run", prompt: "p", cwd: "/tmp/loop" },
      code: "loop_request_failed",
    },
    { msg: { type: "loop/list", requestId: "rt-loop-list" }, code: "loop_request_failed" },
    {
      msg: { type: "loop/inspect", requestId: "rt-loop-inspect", id: "loop-1" },
      code: "loop_request_failed",
    },
    {
      msg: { type: "loop/logs", requestId: "rt-loop-logs", id: "loop-1" },
      code: "loop_request_failed",
    },
    {
      msg: { type: "loop/stop", requestId: "rt-loop-stop", id: "loop-1" },
      code: "loop_request_failed",
    },
    {
      msg: {
        type: "schedule/create",
        requestId: "rt-sched-create",
        prompt: "p",
        cadence: { type: "every", everyMs: 1000 },
        target: { type: "agent", agentId: "00000000-0000-0000-0000-000000000000" },
      },
      code: "schedule_request_failed",
    },
    { msg: { type: "schedule/list", requestId: "rt-sched-list" }, code: "schedule_request_failed" },
    {
      msg: { type: "schedule/inspect", requestId: "rt-sched-inspect", scheduleId: "s1" },
      code: "schedule_request_failed",
    },
    {
      msg: { type: "schedule/logs", requestId: "rt-sched-logs", scheduleId: "s1" },
      code: "schedule_request_failed",
    },
    {
      msg: { type: "schedule/pause", requestId: "rt-sched-pause", scheduleId: "s1" },
      code: "schedule_request_failed",
    },
    {
      msg: { type: "schedule/resume", requestId: "rt-sched-resume", scheduleId: "s1" },
      code: "schedule_request_failed",
    },
    {
      msg: { type: "schedule/delete", requestId: "rt-sched-delete", scheduleId: "s1" },
      code: "schedule_request_failed",
    },
    {
      msg: { type: "schedule/run-once", requestId: "rt-sched-run-once", scheduleId: "s1" },
      code: "schedule_request_failed",
    },
    {
      msg: { type: "schedule/update", requestId: "rt-sched-update", scheduleId: "s1", name: "new" },
      code: "schedule_request_failed",
    },
  ];

  test.each(routingCases)("routes $msg.type to its domain handler", async ({ msg, code }) => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({ messages });

    await session.handleMessage(msg);

    const routed = messages
      .filter(
        (m): m is Extract<SessionOutboundMessage, { type: "rpc_error" }> => m.type === "rpc_error",
      )
      .find((m) => m.payload.requestId === msg.requestId);
    expect(routed, `${msg.type} did not route to a handler (silent no-op)`).toBeDefined();
    expect(routed?.payload.code).toBe(code);
  });
});

describe("agent config setters", () => {
  test("set_agent_mode_request: success emits accepted response carrying the notice", async () => {
    const messages: SessionOutboundMessage[] = [];
    const notice = { type: "info", message: "Switched to plan mode" } as const;
    const session = createSessionForTest({
      messages,
      agentManager: { setAgentMode: vi.fn().mockResolvedValue(notice) },
    });

    await session.handleMessage({
      type: "set_agent_mode_request",
      agentId: "agent-1",
      modeId: "plan",
      requestId: "req-mode-ok",
    });

    expect(messages).toEqual([
      {
        type: "set_agent_mode_response",
        payload: {
          requestId: "req-mode-ok",
          agentId: "agent-1",
          accepted: true,
          error: null,
          notice,
        },
      },
    ]);
  });

  test("set_agent_mode_request: failure emits the activity_log error frame before the rejected response", async () => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({
      messages,
      agentManager: { setAgentMode: vi.fn().mockRejectedValue(new Error("mode boom")) },
    });

    await session.handleMessage({
      type: "set_agent_mode_request",
      agentId: "agent-1",
      modeId: "plan",
      requestId: "req-mode-err",
    });

    expect(messages.map((m) => m.type)).toEqual(["activity_log", "set_agent_mode_response"]);
    expect(messages[0]).toEqual({
      type: "activity_log",
      payload: {
        id: expect.any(String),
        timestamp: expect.any(Date),
        type: "error",
        content: "Failed to set agent mode: mode boom",
      },
    });
    expect(messages[1]).toEqual({
      type: "set_agent_mode_response",
      payload: {
        requestId: "req-mode-err",
        agentId: "agent-1",
        accepted: false,
        error: "mode boom",
      },
    });
  });

  test("set_agent_model_request: success emits accepted response with no notice", async () => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({
      messages,
      agentManager: { setAgentModel: vi.fn().mockResolvedValue(undefined) },
    });

    await session.handleMessage({
      type: "set_agent_model_request",
      agentId: "agent-1",
      modelId: "claude-opus-4-8",
      requestId: "req-model-ok",
    });

    expect(messages).toEqual([
      {
        type: "set_agent_model_response",
        payload: { requestId: "req-model-ok", agentId: "agent-1", accepted: true, error: null },
      },
    ]);
  });

  test("set_agent_model_request: failure emits the activity_log error frame before the rejected response", async () => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({
      messages,
      agentManager: { setAgentModel: vi.fn().mockRejectedValue(new Error("model boom")) },
    });

    await session.handleMessage({
      type: "set_agent_model_request",
      agentId: "agent-1",
      modelId: "claude-opus-4-8",
      requestId: "req-model-err",
    });

    expect(messages.map((m) => m.type)).toEqual(["activity_log", "set_agent_model_response"]);
    expect(messages[0]).toEqual({
      type: "activity_log",
      payload: {
        id: expect.any(String),
        timestamp: expect.any(Date),
        type: "error",
        content: "Failed to set agent model: model boom",
      },
    });
    expect(messages[1]).toEqual({
      type: "set_agent_model_response",
      payload: {
        requestId: "req-model-err",
        agentId: "agent-1",
        accepted: false,
        error: "model boom",
      },
    });
  });

  test("set_agent_feature_request: success emits accepted response with no notice", async () => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({
      messages,
      agentManager: { setAgentFeature: vi.fn().mockResolvedValue(undefined) },
    });

    await session.handleMessage({
      type: "set_agent_feature_request",
      agentId: "agent-1",
      featureId: "web_search",
      value: true,
      requestId: "req-feature-ok",
    });

    expect(messages).toEqual([
      {
        type: "set_agent_feature_response",
        payload: { requestId: "req-feature-ok", agentId: "agent-1", accepted: true, error: null },
      },
    ]);
  });

  test("set_agent_feature_request: failure emits the activity_log error frame before the rejected response", async () => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({
      messages,
      agentManager: { setAgentFeature: vi.fn().mockRejectedValue(new Error("feature boom")) },
    });

    await session.handleMessage({
      type: "set_agent_feature_request",
      agentId: "agent-1",
      featureId: "web_search",
      value: true,
      requestId: "req-feature-err",
    });

    expect(messages.map((m) => m.type)).toEqual(["activity_log", "set_agent_feature_response"]);
    expect(messages[0]).toEqual({
      type: "activity_log",
      payload: {
        id: expect.any(String),
        timestamp: expect.any(Date),
        type: "error",
        content: "Failed to set agent feature: feature boom",
      },
    });
    expect(messages[1]).toEqual({
      type: "set_agent_feature_response",
      payload: {
        requestId: "req-feature-err",
        agentId: "agent-1",
        accepted: false,
        error: "feature boom",
      },
    });
  });

  test("set_agent_thinking_request: success emits accepted response carrying the notice", async () => {
    const messages: SessionOutboundMessage[] = [];
    const notice = { type: "warning", message: "Thinking budget reduced" } as const;
    const session = createSessionForTest({
      messages,
      agentManager: { setAgentThinkingOption: vi.fn().mockResolvedValue(notice) },
    });

    await session.handleMessage({
      type: "set_agent_thinking_request",
      agentId: "agent-1",
      thinkingOptionId: "high",
      requestId: "req-thinking-ok",
    });

    expect(messages).toEqual([
      {
        type: "set_agent_thinking_response",
        payload: {
          requestId: "req-thinking-ok",
          agentId: "agent-1",
          accepted: true,
          error: null,
          notice,
        },
      },
    ]);
  });

  test("set_agent_thinking_request: failure emits the activity_log error frame before the rejected response", async () => {
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({
      messages,
      agentManager: {
        setAgentThinkingOption: vi.fn().mockRejectedValue(new Error("thinking boom")),
      },
    });

    await session.handleMessage({
      type: "set_agent_thinking_request",
      agentId: "agent-1",
      thinkingOptionId: "high",
      requestId: "req-thinking-err",
    });

    expect(messages.map((m) => m.type)).toEqual(["activity_log", "set_agent_thinking_response"]);
    expect(messages[0]).toEqual({
      type: "activity_log",
      payload: {
        id: expect.any(String),
        timestamp: expect.any(Date),
        type: "error",
        content: "Failed to set agent thinking option: thinking boom",
      },
    });
    expect(messages[1]).toEqual({
      type: "set_agent_thinking_response",
      payload: {
        requestId: "req-thinking-err",
        agentId: "agent-1",
        accepted: false,
        error: "thinking boom",
      },
    });
  });
});
