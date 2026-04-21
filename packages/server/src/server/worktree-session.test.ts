import { execSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import pino, { type Logger } from "pino";

import type { SessionOutboundMessage, WorkspaceDescriptorPayload } from "./messages.js";
import { ScriptRouteStore } from "./script-proxy.js";
import {
  archivePaseoWorktree,
  buildAgentSessionConfig,
  handlePaseoWorktreeArchiveRequest,
  handlePaseoWorktreeListRequest,
  resolveGitCreateBaseBranch,
  runWorktreeSetupInBackground,
  handleCreatePaseoWorktreeRequest,
  handleWorkspaceSetupStatusRequest,
} from "./worktree-session.js";
import {
  createWorktree as createWorktreePrimitive,
  type CreateWorktreeOptions,
  type WorktreeConfig,
} from "../utils/worktree.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type { TerminalSession } from "../terminal/terminal.js";
import type { ManagedAgent } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "./workspace-registry.js";
import type { GitHubService } from "../services/github-service.js";
import {
  createPaseoWorktree as createPaseoWorktreeService,
  type CreatePaseoWorktreeFn,
} from "./paseo-worktree-service.js";
import { createWorktreeCoreDeps } from "./worktree-core.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";

interface LegacyCreateWorktreeTestOptions {
  branchName: string;
  cwd: string;
  baseBranch: string;
  worktreeSlug: string;
  runSetup?: boolean;
  paseoHome?: string;
}

function createLegacyWorktreeForTest(
  options: CreateWorktreeOptions | LegacyCreateWorktreeTestOptions,
): Promise<WorktreeConfig> {
  if ("source" in options) {
    return createWorktreePrimitive(options);
  }

  return createWorktreePrimitive({
    cwd: options.cwd,
    worktreeSlug: options.worktreeSlug,
    source: {
      kind: "branch-off",
      baseBranch: options.baseBranch,
      newBranchName: options.branchName,
    },
    runSetup: options.runSetup ?? true,
    paseoHome: options.paseoHome,
  });
}

function createLogger(): Logger {
  const logger = pino({ level: "silent" });
  vi.spyOn(logger, "info").mockImplementation(() => undefined);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
  return logger;
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
    isAuthenticated: async () => true,
    invalidate: () => {},
  };
}

function createTerminalManagerStub(options?: {
  createTerminal?: (input: {
    cwd: string;
    name?: string;
    env?: Record<string, string>;
  }) => Promise<TerminalSession>;
}) {
  const terminals: Array<{
    id: string;
    cwd: string;
    name: string | undefined;
    env: Record<string, string> | undefined;
    sent: string[];
  }> = [];

  return {
    terminals,
    manager: {
      registerCwdEnv: vi.fn(),
      createTerminal: vi.fn(
        async (input: { cwd: string; name?: string; env?: Record<string, string> }) => {
          if (options?.createTerminal) {
            return options.createTerminal(input);
          }
          const sent: string[] = [];
          const terminal = {
            id: `terminal-${terminals.length + 1}`,
            name: input.name ?? "Terminal",
            cwd: input.cwd,
            getState: () => ({
              rows: 1,
              cols: 1,
              scrollback: [[{ char: "$" }]],
              grid: [],
              cursor: { row: 0, col: 0 },
            }),
            subscribe: () => () => {},
            onExit: () => () => {},
            onCommandFinished: () => () => {},
            onTitleChange: () => () => {},
            send: (message: { type: string; data: string }) => {
              if (message.type === "input") {
                sent.push(message.data);
              }
            },
            kill: () => {},
            killAndWait: async () => {},
            getSize: () => ({ rows: 1, cols: 1 }),
            getTitle: () => undefined,
            getExitInfo: () => null,
          } satisfies TerminalSession;
          terminals.push({
            id: terminal.id,
            cwd: input.cwd,
            name: input.name,
            env: input.env,
            sent,
          });
          return terminal;
        },
      ),
      getTerminals: vi.fn(async () => []),
      getTerminal: vi.fn(() => undefined),
      killTerminal: vi.fn(),
      killTerminalAndWait: vi.fn(async () => {}),
      listDirectories: vi.fn(() => []),
      killAll: vi.fn(),
      subscribeTerminalsChanged: vi.fn(() => () => {}),
    } satisfies TerminalManager,
  };
}

function createWorkspaceDescriptor(input: {
  workspace: PersistedWorkspaceRecord;
  repoDir: string;
}): WorkspaceDescriptorPayload {
  return {
    id: input.workspace.workspaceId,
    projectId: input.workspace.projectId,
    projectDisplayName: path.basename(input.repoDir),
    projectRootPath: input.repoDir,
    workspaceDirectory: input.workspace.cwd,
    workspaceKind: "worktree",
    projectKind: "git",
    name: input.workspace.displayName,
    status: "done",
    activityAt: null,
    diffStat: null,
    scripts: [],
    gitRuntime: null,
    githubRuntime: null,
  };
}

function createPaseoWorktreeForTest(options: {
  paseoHome: string;
  events?: string[];
}): CreatePaseoWorktreeFn {
  const projects = new Map<string, PersistedProjectRecord>();
  const workspaces = new Map<string, PersistedWorkspaceRecord>();
  const workspaceGitService = new WorkspaceGitServiceImpl({
    logger: createLogger(),
    paseoHome: options.paseoHome,
    deps: {
      github: createGitHubServiceStub(),
    },
  });

  return (input, serviceOptions) => {
    const coreDeps = createWorktreeCoreDeps(createGitHubServiceStub());
    return createPaseoWorktreeService(input, {
      ...coreDeps,
      ...(serviceOptions?.resolveDefaultBranch
        ? { resolveDefaultBranch: serviceOptions.resolveDefaultBranch }
        : {}),
      projectRegistry: {
        get: async (projectId) => projects.get(projectId) ?? null,
        upsert: async (record) => {
          options.events?.push(`project:${record.projectId}`);
          projects.set(record.projectId, record);
        },
      },
      workspaceRegistry: {
        get: async (workspaceId) => workspaces.get(workspaceId) ?? null,
        list: async () => Array.from(workspaces.values()),
        upsert: async (record) => {
          options.events?.push(`workspace:${record.workspaceId}`);
          workspaces.set(record.workspaceId, record);
        },
      },
      workspaceGitService,
      primeWorkspaceGitWatchFingerprints: async (workspace) => {
        options.events?.push(`prime:${workspace.workspaceId}`);
      },
      broadcastWorkspaceUpdate: async (workspaceId) => {
        options.events?.push(`broadcast:${workspaceId}`);
      },
    });
  };
}

function createManagedAgentForArchive(input: { id: string; cwd: string }): ManagedAgent {
  const now = new Date();
  return {
    id: input.id,
    provider: "codex",
    cwd: input.cwd,
    capabilities: {
      supportsStreaming: false,
      supportsSessionPersistence: false,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    config: { provider: "codex", cwd: input.cwd },
    createdAt: now,
    updatedAt: now,
    availableModes: [],
    currentModeId: null,
    pendingPermissions: new Map(),
    bufferedPermissionResolutions: new Map(),
    inFlightPermissionResponses: new Set(),
    pendingReplacement: false,
    persistence: null,
    historyPrimed: false,
    lastUserMessageAt: null,
    attention: { requiresAttention: false },
    foregroundTurnWaiters: new Set(),
    unsubscribeSession: null,
    labels: {},
    lifecycle: "closed",
    session: null,
    activeForegroundTurnId: null,
  };
}

describe("handlePaseoWorktreeListRequest", () => {
  test("lists worktrees through the workspace git service", async () => {
    const emitted: SessionOutboundMessage[] = [];
    const workspaceGitService = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: "/tmp/paseo-home/worktrees/repo/feature",
          createdAt: "2026-04-12T00:00:00.000Z",
          branchName: "feature",
          head: "abc123",
        },
      ]),
    };

    await handlePaseoWorktreeListRequest(
      {
        emit: (message) => emitted.push(message),
        paseoHome: "/tmp/paseo-home",
        workspaceGitService: workspaceGitService as any,
      },
      {
        type: "paseo_worktree_list_request",
        cwd: "/tmp/repo",
        requestId: "request-worktrees",
      },
    );

    expect(workspaceGitService.listWorktrees).toHaveBeenCalledTimes(1);
    expect(workspaceGitService.listWorktrees).toHaveBeenCalledWith("/tmp/repo");
    expect(emitted).toContainEqual({
      type: "paseo_worktree_list_response",
      payload: {
        worktrees: [
          {
            worktreePath: "/tmp/paseo-home/worktrees/repo/feature",
            createdAt: "2026-04-12T00:00:00.000Z",
            branchName: "feature",
            head: "abc123",
          },
        ],
        error: null,
        requestId: "request-worktrees",
      },
    });
  });
});

describe("resolveGitCreateBaseBranch", () => {
  test("resolves the default branch through the workspace git service", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const cwd = path.join(repoDir, "packages", "app");
    const workspaceGitService = {
      resolveDefaultBranch: vi.fn().mockResolvedValue("main"),
      getSnapshot: vi.fn(async () => {
        throw new Error("getSnapshot should not be used for default-branch resolution");
      }),
    };

    try {
      await expect(resolveGitCreateBaseBranch(cwd, workspaceGitService as any)).resolves.toBe(
        "main",
      );

      expect(workspaceGitService.resolveDefaultBranch).toHaveBeenCalledWith(cwd);
      expect(workspaceGitService.getSnapshot).not.toHaveBeenCalled();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function createAgentStorageStub(): Pick<AgentStorage, "list" | "remove"> {
  return {
    list: async (): Promise<StoredAgentRecord[]> => [],
    remove: vi.fn(async () => {}),
  };
}

function createGitRepo(options?: { paseoConfig?: Record<string, unknown> }) {
  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "worktree-session-test-")));
  const repoDir = path.join(tempDir, "repo");
  execSync(`mkdir -p ${JSON.stringify(repoDir)}`);
  execSync("git init -b main", { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.email 'test@test.com'", { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.name 'Test'", { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  if (options?.paseoConfig) {
    writeFileSync(path.join(repoDir, "paseo.json"), JSON.stringify(options.paseoConfig, null, 2));
  }
  execSync("git add .", { cwd: repoDir, stdio: "pipe" });
  execSync("git -c commit.gpgsign=false commit -m 'initial'", { cwd: repoDir, stdio: "pipe" });
  return { tempDir, repoDir };
}

function createGitHubPrRemoteRepo() {
  const { tempDir, repoDir } = createGitRepo();
  const featureBranch = "feature/review-pr";
  execSync(`git checkout -b ${JSON.stringify(featureBranch)}`, { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "review branch\n");
  execSync("git add README.md", { cwd: repoDir, stdio: "pipe" });
  execSync("git -c commit.gpgsign=false commit -m 'review branch'", {
    cwd: repoDir,
    stdio: "pipe",
  });
  const featureSha = execSync("git rev-parse HEAD", { cwd: repoDir, stdio: "pipe" })
    .toString()
    .trim();
  execSync("git checkout main", { cwd: repoDir, stdio: "pipe" });
  execSync(`git branch -D ${JSON.stringify(featureBranch)}`, { cwd: repoDir, stdio: "pipe" });

  const remoteDir = path.join(tempDir, "remote.git");
  execSync(`git clone --bare ${JSON.stringify(repoDir)} ${JSON.stringify(remoteDir)}`, {
    stdio: "pipe",
  });
  execSync(
    `git --git-dir=${JSON.stringify(remoteDir)} update-ref refs/pull/123/head ${featureSha}`,
    {
      stdio: "pipe",
    },
  );
  execSync(`git remote add origin ${JSON.stringify(remoteDir)}`, { cwd: repoDir, stdio: "pipe" });
  execSync("git fetch origin", { cwd: repoDir, stdio: "pipe" });

  return { tempDir, repoDir };
}

describe("runWorktreeSetupInBackground", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("emits running then completed snapshots for no-setup workspaces without auto-starting scripts", async () => {
    const { tempDir, repoDir } = createGitRepo({
      paseoConfig: {
        scripts: {
          web: {
            command: "npm run dev",
          },
        },
      },
    });
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const createdWorktree = await createLegacyWorktreeForTest({
      branchName: "feature-no-setup",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "feature-no-setup",
      runSetup: false,
      paseoHome,
    });
    const worktreePath = createdWorktree.worktreePath;
    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map<string, unknown>();
    const logger = createLogger();
    const terminalManager = createTerminalManagerStub();
    const emitWorkspaceUpdateForCwd = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await runWorktreeSetupInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForCwd,
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) =>
          snapshots.set(workspaceId, snapshot),
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: terminalManager.manager,
        archiveWorkspaceRecord,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        workspaceId: "42",
        worktree: {
          branchName: "feature-no-setup",
          worktreePath,
        },
        shouldBootstrap: true,
        slug: "feature-no-setup",
        worktreePath,
      },
    );

    const progressMessages = emitted.filter(
      (message): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
        message.type === "workspace_setup_progress",
    );
    expect(progressMessages).toHaveLength(2);
    expect(progressMessages[0]?.payload).toMatchObject({
      workspaceId: "42",
      status: "running",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath,
        branchName: "feature-no-setup",
        log: "",
        commands: [],
      },
    });
    expect(progressMessages[1]?.payload).toMatchObject({
      workspaceId: "42",
      status: "completed",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath,
        branchName: "feature-no-setup",
        log: "",
        commands: [],
      },
    });
    expect(snapshots.get("42")).toMatchObject({
      status: "completed",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath,
        branchName: "feature-no-setup",
        log: "",
        commands: [],
      },
    });

    expect(terminalManager.terminals).toHaveLength(0);
    expect(archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(emitWorkspaceUpdateForCwd).toHaveBeenCalledWith(worktreePath);
  });

  test("archives the pending workspace and emits a failed snapshot when setup cannot start", async () => {
    const { tempDir, repoDir } = createGitRepo();
    cleanupPaths.push(tempDir);

    writeFileSync(path.join(repoDir, "paseo.json"), "{ invalid json\n");
    execSync("git add paseo.json", { cwd: repoDir, stdio: "pipe" });
    execSync("git -c commit.gpgsign=false commit -m 'broken config'", {
      cwd: repoDir,
      stdio: "pipe",
    });

    const paseoHome = path.join(tempDir, ".paseo");
    const createdWorktree = await createLegacyWorktreeForTest({
      branchName: "broken-feature",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "broken-feature",
      runSetup: false,
      paseoHome,
    });
    const worktreePath = createdWorktree.worktreePath;
    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map<string, unknown>();
    const logger = createLogger();
    const emitWorkspaceUpdateForCwd = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});
    const workspaceId = "ws-broken-feature";

    await runWorktreeSetupInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForCwd,
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) =>
          snapshots.set(workspaceId, snapshot),
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: null,
        archiveWorkspaceRecord,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        workspaceId,
        worktree: {
          branchName: "broken-feature",
          worktreePath,
        },
        shouldBootstrap: true,
        slug: "broken-feature",
        worktreePath,
      },
    );

    const progressMessages = emitted.filter(
      (message): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
        message.type === "workspace_setup_progress",
    );
    expect(progressMessages).toHaveLength(2);
    expect(progressMessages[0]?.payload.status).toBe("running");
    expect(progressMessages[0]?.payload.error).toBeNull();
    expect(progressMessages[1]?.payload.status).toBe("failed");
    expect(progressMessages[1]?.payload.error).toContain("Failed to parse paseo.json");
    expect(progressMessages[1]?.payload.detail.commands).toEqual([]);
    expect(snapshots.get(workspaceId)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Failed to parse paseo.json"),
    });
    expect(archiveWorkspaceRecord).toHaveBeenCalledWith(workspaceId);
    expect(emitWorkspaceUpdateForCwd).toHaveBeenCalledWith(worktreePath);
  });

  test("emits running setup snapshots before completed for real setup commands", async () => {
    const { tempDir, repoDir } = createGitRepo({
      paseoConfig: {
        worktree: {
          setup: ["sh -c \"printf 'phase-one\\\\n'; sleep 0.1; printf 'phase-two\\\\n'\""],
        },
      },
    });
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const createdWorktree = await createLegacyWorktreeForTest({
      branchName: "feature-running-setup",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "feature-running-setup",
      runSetup: false,
      paseoHome,
    });
    const worktreePath = createdWorktree.worktreePath;
    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map<string, unknown>();
    const logger = createLogger();
    const emitWorkspaceUpdateForCwd = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await runWorktreeSetupInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForCwd,
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) =>
          snapshots.set(workspaceId, snapshot),
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: null,
        archiveWorkspaceRecord,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        workspaceId: "43",
        worktree: {
          branchName: "feature-running-setup",
          worktreePath,
        },
        shouldBootstrap: true,
        slug: "feature-running-setup",
        worktreePath,
      },
    );

    const progressMessages = emitted.filter(
      (message): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
        message.type === "workspace_setup_progress",
    );
    expect(progressMessages.length).toBeGreaterThan(1);
    expect(progressMessages[0]?.payload).toMatchObject({
      workspaceId: "43",
      status: "running",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath,
        branchName: "feature-running-setup",
        log: "",
        commands: [],
      },
    });
    expect(progressMessages.at(-1)?.payload.status).toBe("completed");

    const runningMessages = progressMessages.filter(
      (message) => message.payload.status === "running",
    );
    expect(runningMessages.length).toBeGreaterThan(0);
    expect(
      progressMessages.findIndex((message) => message.payload.status === "running"),
    ).toBeLessThan(progressMessages.findIndex((message) => message.payload.status === "completed"));

    const setupOutputMessage = runningMessages.find((message) =>
      message.payload.detail.commands[0]?.log.includes("phase-one"),
    );
    expect(setupOutputMessage?.payload.detail.log).toContain("phase-one");
    expect(setupOutputMessage?.payload.detail.commands[0]).toMatchObject({
      index: 1,
      command: "sh -c \"printf 'phase-one\\\\n'; sleep 0.1; printf 'phase-two\\\\n'\"",
      log: expect.stringContaining("phase-one"),
      status: "running",
    });

    expect(progressMessages.at(-1)?.payload).toMatchObject({
      workspaceId: "43",
      status: "completed",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath,
        branchName: "feature-running-setup",
      },
    });
    expect(progressMessages.at(-1)?.payload.detail.log).toContain("phase-two");
    expect(progressMessages.at(-1)?.payload.detail.commands[0]).toMatchObject({
      index: 1,
      command: "sh -c \"printf 'phase-one\\\\n'; sleep 0.1; printf 'phase-two\\\\n'\"",
      log: expect.stringContaining("phase-two"),
      status: "completed",
      exitCode: 0,
    });
    expect(snapshots.get("43")).toMatchObject({
      status: "completed",
      error: null,
    });
  });

  test("emits completed when reusing an existing worktree without bootstrapping or auto-starting scripts", async () => {
    const { tempDir, repoDir } = createGitRepo({
      paseoConfig: {
        worktree: {
          setup: ["printf 'ran' > setup-ran.txt"],
        },
        scripts: {
          web: {
            command: "npm run dev",
          },
        },
      },
    });
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const existingWorktree = await createLegacyWorktreeForTest({
      branchName: "reused-worktree",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "reused-worktree",
      runSetup: false,
      paseoHome,
    });

    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map<string, unknown>();
    const logger = createLogger();
    const terminalManager = createTerminalManagerStub();
    const emitWorkspaceUpdateForCwd = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await runWorktreeSetupInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForCwd,
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) =>
          snapshots.set(workspaceId, snapshot),
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: terminalManager.manager,
        archiveWorkspaceRecord,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        workspaceId: "44",
        worktree: {
          branchName: "reused-worktree",
          worktreePath: existingWorktree.worktreePath,
        },
        shouldBootstrap: false,
        slug: "reused-worktree",
        worktreePath: existingWorktree.worktreePath,
      },
    );

    const progressMessages = emitted.filter(
      (message): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
        message.type === "workspace_setup_progress",
    );
    expect(progressMessages).toHaveLength(2);
    expect(progressMessages[0]?.payload).toMatchObject({
      workspaceId: "44",
      status: "running",
      error: null,
    });
    expect(progressMessages[1]?.payload).toMatchObject({
      workspaceId: "44",
      status: "completed",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath: existingWorktree.worktreePath,
        branchName: "reused-worktree",
        log: "",
        commands: [],
      },
    });
    expect(terminalManager.terminals).toHaveLength(0);
    expect(readFileSync(path.join(existingWorktree.worktreePath, "README.md"), "utf8")).toContain(
      "hello",
    );
    expect(() =>
      readFileSync(path.join(existingWorktree.worktreePath, "setup-ran.txt"), "utf8"),
    ).toThrow();
    expect(snapshots.get("44")).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(emitWorkspaceUpdateForCwd).toHaveBeenCalledWith(existingWorktree.worktreePath);
  });

  test("keeps setup completed without attempting script launch afterward", async () => {
    const { tempDir, repoDir } = createGitRepo({
      paseoConfig: {
        scripts: {
          web: {
            command: "npm run dev",
          },
        },
      },
    });
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const createdWorktree = await createLegacyWorktreeForTest({
      branchName: "feature-service-failure",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "feature-service-failure",
      runSetup: false,
      paseoHome,
    });
    const worktreePath = createdWorktree.worktreePath;
    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map<string, unknown>();
    const logger = createLogger();
    const terminalManager = createTerminalManagerStub({
      createTerminal: async () => {
        throw new Error("terminal spawn failed");
      },
    });
    const emitWorkspaceUpdateForCwd = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await runWorktreeSetupInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForCwd,
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) =>
          snapshots.set(workspaceId, snapshot),
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: terminalManager.manager,
        archiveWorkspaceRecord,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        workspaceId: "45",
        worktree: {
          branchName: "feature-service-failure",
          worktreePath,
        },
        shouldBootstrap: true,
        slug: "feature-service-failure",
        worktreePath,
      },
    );

    const progressMessages = emitted.filter(
      (message): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
        message.type === "workspace_setup_progress",
    );
    expect(progressMessages).toHaveLength(2);
    expect(progressMessages[0]?.payload.status).toBe("running");
    expect(progressMessages[0]?.payload.error).toBeNull();
    expect(progressMessages[1]?.payload.status).toBe("completed");
    expect(progressMessages[1]?.payload.error).toBeNull();
    expect(
      emitted.some(
        (message) =>
          message.type === "workspace_setup_progress" && message.payload.status === "failed",
      ),
    ).toBe(false);
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.anything(),
      "Failed to spawn worktree scripts after workspace setup completed",
    );
    expect(terminalManager.terminals).toHaveLength(0);
    expect(snapshots.get("45")).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(emitWorkspaceUpdateForCwd).toHaveBeenCalledWith(worktreePath);
  });

  test("does not auto-start scripts in socket mode", async () => {
    const { tempDir, repoDir } = createGitRepo({
      paseoConfig: {
        scripts: {
          web: {
            command: "npm run dev",
          },
        },
      },
    });
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const createdWorktree = await createLegacyWorktreeForTest({
      branchName: "feature-socket-mode",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "feature-socket-mode",
      runSetup: false,
      paseoHome,
    });
    const worktreePath = createdWorktree.worktreePath;
    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map<string, unknown>();
    const logger = createLogger();
    const terminalManager = createTerminalManagerStub();
    const emitWorkspaceUpdateForCwd = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await runWorktreeSetupInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForCwd,
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) =>
          snapshots.set(workspaceId, snapshot),
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: terminalManager.manager,
        archiveWorkspaceRecord,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        workspaceId: "46",
        worktree: {
          branchName: "feature-socket-mode",
          worktreePath,
        },
        shouldBootstrap: true,
        slug: "feature-socket-mode",
        worktreePath,
      },
    );

    expect(terminalManager.terminals).toHaveLength(0);
    expect(snapshots.get("46")).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(emitWorkspaceUpdateForCwd).toHaveBeenCalledWith(worktreePath);
  });

  test("returns the cached workspace setup snapshot for status requests", async () => {
    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map([
      [
        "ws-feature-a",
        {
          status: "completed",
          detail: {
            type: "worktree_setup",
            worktreePath: "/repo/.paseo/worktrees/feature-a",
            branchName: "feature-a",
            log: "done",
            commands: [],
          },
          error: null,
        },
      ],
    ]);

    await handleWorkspaceSetupStatusRequest(
      {
        emit: (message) => emitted.push(message),
        workspaceSetupSnapshots: snapshots,
      },
      {
        type: "workspace_setup_status_request",
        workspaceId: "ws-feature-a",
        requestId: "req-status",
      },
    );

    expect(emitted).toContainEqual({
      type: "workspace_setup_status_response",
      payload: {
        requestId: "req-status",
        workspaceId: "ws-feature-a",
        snapshot: {
          status: "completed",
          detail: {
            type: "worktree_setup",
            worktreePath: "/repo/.paseo/worktrees/feature-a",
            branchName: "feature-a",
            log: "done",
            commands: [],
          },
          error: null,
        },
      },
    });
  });

  test("returns null when no cached workspace setup snapshot exists", async () => {
    const emitted: SessionOutboundMessage[] = [];

    await handleWorkspaceSetupStatusRequest(
      {
        emit: (message) => emitted.push(message),
        workspaceSetupSnapshots: new Map(),
      },
      {
        type: "workspace_setup_status_request",
        workspaceId: "ws-missing",
        requestId: "req-missing",
      },
    );

    expect(emitted).toContainEqual({
      type: "workspace_setup_status_response",
      payload: {
        requestId: "req-missing",
        workspaceId: "ws-missing",
        snapshot: null,
      },
    });
  });
});

describe("handleCreatePaseoWorktreeRequest", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("checks out the GitHub PR branch when a github_pr attachment is present", async () => {
    const { tempDir, repoDir } = createGitHubPrRemoteRepo();
    cleanupPaths.push(tempDir);

    const emitted: SessionOutboundMessage[] = [];
    const logger = createLogger();
    const paseoHome = path.join(tempDir, ".paseo");

    await handleCreatePaseoWorktreeRequest(
      {
        paseoHome,
        describeWorkspaceRecord: async (workspace) =>
          createWorkspaceDescriptor({ workspace, repoDir }),
        emit: (message) => emitted.push(message),
        createPaseoWorktree: createPaseoWorktreeForTest({ paseoHome }),
        sessionLogger: logger,
        runWorktreeSetupInBackground: async () => {},
      },
      {
        type: "create_paseo_worktree_request",
        requestId: "req-pr-worktree",
        cwd: repoDir,
        worktreeSlug: "review-pr-123",
        attachments: [
          {
            type: "github_pr",
            mimeType: "application/github-pr",
            number: 123,
            title: "Review branch",
            url: "https://github.com/getpaseo/paseo/pull/123",
            baseRefName: "main",
            headRefName: "feature/review-pr",
          },
        ],
      },
    );

    const response = emitted.find(
      (
        message,
      ): message is Extract<SessionOutboundMessage, { type: "create_paseo_worktree_response" }> =>
        message.type === "create_paseo_worktree_response",
    );

    expect(response?.payload.error).toBeNull();
    expect(response?.payload.workspace?.workspaceDirectory).toBeTruthy();

    const worktreePath = response?.payload.workspace?.workspaceDirectory;
    expect(worktreePath).toBeTruthy();
    if (!worktreePath) {
      return;
    }

    const branch = execSync("git branch --show-current", { cwd: worktreePath, stdio: "pipe" })
      .toString()
      .trim();
    expect(branch).toBe("feature/review-pr");

    const readme = readFileSync(path.join(worktreePath, "README.md"), "utf8");
    expect(readme).toContain("review branch");
  });

  test("buildAgentSessionConfig checks out the GitHub PR branch for agent worktrees", async () => {
    const { tempDir, repoDir } = createGitHubPrRemoteRepo();
    cleanupPaths.push(tempDir);
    const events: string[] = [];

    const result = await buildAgentSessionConfig(
      {
        paseoHome: path.join(tempDir, ".paseo"),
        sessionLogger: createLogger(),
        createPaseoWorktree: createPaseoWorktreeForTest({
          paseoHome: path.join(tempDir, ".paseo"),
          events,
        }),
        checkoutExistingBranch: async () => {
          throw new Error("should not checkout existing branch");
        },
        createBranchFromBase: async () => {
          throw new Error("should not create a new branch from base");
        },
      },
      {
        provider: "codex",
        cwd: repoDir,
      },
      {
        createWorktree: true,
        worktreeSlug: "agent-review-pr-123",
      },
      undefined,
      [
        {
          type: "github_pr",
          mimeType: "application/github-pr",
          number: 123,
          title: "Review branch",
          url: "https://github.com/getpaseo/paseo/pull/123",
          baseRefName: "main",
          headRefName: "feature/review-pr",
        },
      ],
    );

    expect(result.worktreeBootstrap?.worktree.branchName).toBe("feature/review-pr");
    expect(result.worktreeBootstrap?.worktree.worktreePath).toContain("agent-review-pr-123");
    expect(events.some((event) => event.startsWith("workspace:"))).toBe(true);
    expect(events.some((event) => event.startsWith("broadcast:"))).toBe(true);

    const branch = execSync("git branch --show-current", {
      cwd: result.sessionConfig.cwd,
      stdio: "pipe",
    })
      .toString()
      .trim();
    expect(branch).toBe("feature/review-pr");
  });

  test("buildAgentSessionConfig uses the normalized new branch name as the worktree slug fallback", async () => {
    const { tempDir, repoDir } = createGitRepo();
    cleanupPaths.push(tempDir);
    const paseoHome = path.join(tempDir, ".paseo");

    const result = await buildAgentSessionConfig(
      {
        paseoHome,
        sessionLogger: createLogger(),
        workspaceGitService: {
          resolveRepoRoot: vi.fn(async () => repoDir),
          resolveDefaultBranch: vi.fn(async () => "main"),
        } as any,
        createPaseoWorktree: createPaseoWorktreeForTest({ paseoHome }),
        checkoutExistingBranch: async () => {
          throw new Error("should not checkout existing branch");
        },
        createBranchFromBase: async () => {
          throw new Error("should not create a branch outside the worktree service");
        },
      },
      {
        provider: "codex",
        cwd: repoDir,
      },
      {
        createWorktree: true,
        createNewBranch: true,
        newBranchName: "feature-x",
      },
    );

    expect(result.worktreeBootstrap?.worktree.branchName).toBe("feature-x");
    expect(path.basename(result.worktreeBootstrap?.worktree.worktreePath ?? "")).toBe("feature-x");
  });

  test("buildAgentSessionConfig invalidates GitHub cache after branch setup mutations", async () => {
    const invalidate = vi.fn();
    const createBranchFromBase = vi.fn(async () => {});
    const checkoutExistingBranch = vi.fn(async () => ({ source: "local" as const }));
    const createPaseoWorktree = vi.fn(async () => {
      throw new Error("should not create worktree");
    });

    await buildAgentSessionConfig(
      {
        sessionLogger: createLogger(),
        createPaseoWorktree,
        checkoutExistingBranch,
        createBranchFromBase,
        github: { invalidate },
      },
      {
        provider: "codex",
        cwd: "/tmp/repo",
      },
      {
        createNewBranch: true,
        baseBranch: "main",
        newBranchName: "feature-x",
      },
    );

    expect(createBranchFromBase).toHaveBeenCalledWith({
      cwd: "/tmp/repo",
      baseBranch: "main",
      newBranchName: "feature-x",
    });
    expect(invalidate).toHaveBeenCalledWith({ cwd: "/tmp/repo" });

    invalidate.mockClear();

    await buildAgentSessionConfig(
      {
        sessionLogger: createLogger(),
        createPaseoWorktree,
        checkoutExistingBranch,
        createBranchFromBase,
        github: { invalidate },
      },
      {
        provider: "codex",
        cwd: "/tmp/repo",
      },
      {
        baseBranch: "release",
      },
    );

    expect(checkoutExistingBranch).toHaveBeenCalledWith("/tmp/repo", "release");
    expect(invalidate).toHaveBeenCalledWith({ cwd: "/tmp/repo" });
  });

  test("createPaseoWorktreeForTest forwards the default branch resolver for branch-off intents", async () => {
    const { tempDir, repoDir } = createGitRepo();
    cleanupPaths.push(tempDir);
    const paseoHome = path.join(tempDir, ".paseo");
    const resolveDefaultBranch = vi.fn(async () => "main");

    const result = await createPaseoWorktreeForTest({ paseoHome })(
      {
        cwd: repoDir,
        worktreeSlug: "resolver-feature",
        action: "branch-off",
        runSetup: false,
        paseoHome,
      },
      { resolveDefaultBranch },
    );

    expect(result.intent).toMatchObject({
      kind: "branch-off",
      baseBranch: "main",
      newBranchName: "resolver-feature",
    });
    expect(resolveDefaultBranch).toHaveBeenCalledWith(repoDir);
  });
});

describe("handleCreatePaseoWorktreeRequest", () => {
  test("registers a pending workspace and emits a successful create response", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const emitted: SessionOutboundMessage[] = [];
    const events: string[] = [];

    try {
      await handleCreatePaseoWorktreeRequest(
        {
          paseoHome,
          sessionLogger: createLogger(),
          emit: (message) => emitted.push(message),
          createPaseoWorktree: createPaseoWorktreeForTest({ paseoHome, events }),
          describeWorkspaceRecord: vi.fn(async (workspace) => ({
            id: workspace.workspaceId,
            projectId: workspace.projectId,
            projectDisplayName: path.basename(repoDir),
            projectRootPath: repoDir,
            projectKind: "git",
            workspaceKind: "worktree",
            name: "single-call",
            status: "done",
            activityAt: null,
          })),
          runWorktreeSetupInBackground: vi.fn(async () => {}),
        },
        {
          type: "create_paseo_worktree_request",
          cwd: repoDir,
          worktreeSlug: "single-call",
          requestId: "req-single-call",
        },
      );

      expect(events.some((event) => event.startsWith("workspace:"))).toBe(true);
      expect(events.some((event) => event.startsWith("broadcast:"))).toBe(true);
      const response = emitted.find(
        (
          message,
        ): message is Extract<SessionOutboundMessage, { type: "create_paseo_worktree_response" }> =>
          message.type === "create_paseo_worktree_response",
      );
      expect(response?.payload.error).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("creates the worktree before emitting the response", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const emitted: SessionOutboundMessage[] = [];
    const backgroundWork = vi.fn(async () => {});
    let registeredWorktreePath: string | null = null;

    try {
      await handleCreatePaseoWorktreeRequest(
        {
          paseoHome,
          sessionLogger: createLogger(),
          emit: (message) => emitted.push(message),
          createPaseoWorktree: async (input) => {
            const result = await createPaseoWorktreeForTest({ paseoHome })(input);
            expect(existsSync(result.worktree.worktreePath)).toBe(true);
            registeredWorktreePath = result.worktree.worktreePath;
            return result;
          },
          describeWorkspaceRecord: vi.fn(async (workspace) =>
            createWorkspaceDescriptor({ workspace, repoDir }),
          ),
          runWorktreeSetupInBackground: backgroundWork,
        },
        {
          type: "create_paseo_worktree_request",
          cwd: repoDir,
          worktreeSlug: "response-after-create",
          requestId: "req-1",
        },
      );

      const response = emitted.find(
        (
          message,
        ): message is Extract<SessionOutboundMessage, { type: "create_paseo_worktree_response" }> =>
          message.type === "create_paseo_worktree_response",
      );
      expect(response?.payload.error).toBeNull();
      expect(response?.payload.workspace?.id).toBeTruthy();
      expect(registeredWorktreePath).toBeTruthy();
      expect(existsSync(registeredWorktreePath!)).toBe(true);
      expect(backgroundWork).toHaveBeenCalledWith(
        expect.objectContaining({
          requestCwd: repoDir,
          repoRoot: repoDir,
          worktree: {
            branchName: "response-after-create",
            worktreePath: registeredWorktreePath,
          },
          shouldBootstrap: true,
        }),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("emits a machine-readable error code for invalid worktree intent", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const emitted: SessionOutboundMessage[] = [];

    try {
      await handleCreatePaseoWorktreeRequest(
        {
          paseoHome,
          sessionLogger: createLogger(),
          emit: (message) => emitted.push(message),
          createPaseoWorktree: createPaseoWorktreeForTest({ paseoHome }),
          describeWorkspaceRecord: vi.fn(async (workspace) =>
            createWorkspaceDescriptor({ workspace, repoDir }),
          ),
          runWorktreeSetupInBackground: vi.fn(async () => {}),
        },
        {
          type: "create_paseo_worktree_request",
          cwd: repoDir,
          action: "checkout",
          attachments: [],
          requestId: "req-missing-target",
        },
      );

      const response = emitted.find(
        (
          message,
        ): message is Extract<SessionOutboundMessage, { type: "create_paseo_worktree_response" }> =>
          message.type === "create_paseo_worktree_response",
      );
      expect(response?.payload.workspace).toBeNull();
      expect(response?.payload.error).toBe('action "checkout" requires refName or githubPrNumber');
      expect(response?.payload.errorCode).toBe("missing_checkout_target");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("emits a machine-readable error code for unknown checkout branches", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const emitted: SessionOutboundMessage[] = [];

    try {
      await handleCreatePaseoWorktreeRequest(
        {
          paseoHome,
          sessionLogger: createLogger(),
          emit: (message) => emitted.push(message),
          createPaseoWorktree: createPaseoWorktreeForTest({ paseoHome }),
          describeWorkspaceRecord: vi.fn(async (workspace) =>
            createWorkspaceDescriptor({ workspace, repoDir }),
          ),
          runWorktreeSetupInBackground: vi.fn(async () => {}),
        },
        {
          type: "create_paseo_worktree_request",
          cwd: repoDir,
          action: "checkout",
          refName: "missing-branch",
          attachments: [],
          requestId: "req-unknown-branch",
        },
      );

      const response = emitted.find(
        (
          message,
        ): message is Extract<SessionOutboundMessage, { type: "create_paseo_worktree_response" }> =>
          message.type === "create_paseo_worktree_response",
      );
      expect(response?.payload.workspace).toBeNull();
      expect(response?.payload.error).toBe("Unknown branch: missing-branch");
      expect(response?.payload.errorCode).toBe("unknown_branch");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("archivePaseoWorktree", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  function createIsPathWithinRoot() {
    return (rootPath: string, candidatePath: string) => {
      const normalizedRoot = path.resolve(rootPath);
      const normalizedCandidate = path.resolve(candidatePath);
      return (
        normalizedCandidate === normalizedRoot ||
        normalizedCandidate.startsWith(normalizedRoot + path.sep)
      );
    };
  }

  test("runs agent close and terminal teardown concurrently and removes the worktree", async () => {
    const { tempDir, repoDir } = createGitRepo();
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const created = await createLegacyWorktreeForTest({
      branchName: "archive-parallel",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "archive-parallel",
      runSetup: false,
      paseoHome,
    });

    const teardownStartTimes: Record<string, number> = {};
    const teardownEndTimes: Record<string, number> = {};
    const closeAgentSpy = vi.fn(async (agentId: string) => {
      teardownStartTimes[agentId] = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 100));
      teardownEndTimes[agentId] = Date.now();
    });
    const killTerminalsUnderPath = vi.fn(async () => {
      teardownStartTimes.__terminals = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 100));
      teardownEndTimes.__terminals = Date.now();
    });

    const emitted: SessionOutboundMessage[] = [];
    const removedAgents = await archivePaseoWorktree(
      {
        paseoHome,
        github: createGitHubServiceStub(),
        agentManager: {
          listAgents: () => [
            createManagedAgentForArchive({ id: "agent-1", cwd: created.worktreePath }),
            createManagedAgentForArchive({ id: "agent-2", cwd: created.worktreePath }),
          ],
          closeAgent: closeAgentSpy,
        },
        agentStorage: createAgentStorageStub(),
        archiveWorkspaceRecord: vi.fn(async () => {}),
        emit: (msg) => emitted.push(msg),
        emitWorkspaceUpdatesForCwds: vi.fn(async () => {}),
        isPathWithinRoot: createIsPathWithinRoot(),
        killTerminalsUnderPath,
        sessionLogger: createLogger(),
      },
      {
        targetPath: created.worktreePath,
        repoRoot: repoDir,
        requestId: "req-archive-parallel",
      },
    );

    expect(removedAgents).toEqual(expect.arrayContaining(["agent-1", "agent-2"]));
    expect(existsSync(created.worktreePath)).toBe(false);
    expect(closeAgentSpy).toHaveBeenCalledTimes(2);
    expect(killTerminalsUnderPath).toHaveBeenCalledWith(created.worktreePath);

    // All teardown work must overlap — sequential would take ~300ms, parallel ~100ms.
    const starts = Object.values(teardownStartTimes);
    const ends = Object.values(teardownEndTimes);
    const maxEnd = Math.max(...ends);
    const minStart = Math.min(...starts);
    expect(maxEnd - minStart).toBeLessThan(220);
  });

  test("proceeds to FS delete even when terminal teardown rejects", async () => {
    const { tempDir, repoDir } = createGitRepo();
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const created = await createLegacyWorktreeForTest({
      branchName: "archive-terminal-throws",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "archive-terminal-throws",
      runSetup: false,
      paseoHome,
    });

    const killTerminalsUnderPath = vi.fn(async () => {
      throw new Error("simulated terminal teardown failure");
    });

    await archivePaseoWorktree(
      {
        paseoHome,
        github: createGitHubServiceStub(),
        agentManager: {
          listAgents: () => [],
          closeAgent: vi.fn(async () => {}),
        },
        agentStorage: createAgentStorageStub(),
        archiveWorkspaceRecord: vi.fn(async () => {}),
        emit: vi.fn(),
        emitWorkspaceUpdatesForCwds: vi.fn(async () => {}),
        isPathWithinRoot: createIsPathWithinRoot(),
        killTerminalsUnderPath,
        sessionLogger: createLogger(),
      },
      {
        targetPath: created.worktreePath,
        repoRoot: repoDir,
        requestId: "req-archive-terminal-throws",
      },
    );

    expect(killTerminalsUnderPath).toHaveBeenCalledTimes(1);
    expect(existsSync(created.worktreePath)).toBe(false);
  });

  test("forces a workspace git snapshot refresh after archive deletes a worktree", async () => {
    const { tempDir, repoDir } = createGitRepo();
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const created = await createLegacyWorktreeForTest({
      branchName: "archive-refresh",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "archive-refresh",
      runSetup: false,
      paseoHome,
    });
    const workspaceGitService = {
      getSnapshot: vi.fn(async () => null),
    };

    await archivePaseoWorktree(
      {
        paseoHome,
        github: createGitHubServiceStub(),
        workspaceGitService: workspaceGitService as any,
        agentManager: {
          listAgents: () => [],
          closeAgent: vi.fn(async () => {}),
        },
        agentStorage: createAgentStorageStub(),
        archiveWorkspaceRecord: vi.fn(async () => {}),
        emit: vi.fn(),
        emitWorkspaceUpdatesForCwds: vi.fn(async () => {}),
        isPathWithinRoot: createIsPathWithinRoot(),
        killTerminalsUnderPath: vi.fn(async () => {}),
        sessionLogger: createLogger(),
      },
      {
        targetPath: created.worktreePath,
        repoRoot: repoDir,
        requestId: "req-archive-refresh",
      },
    );

    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith(repoDir, {
      force: true,
      reason: "archive-worktree",
    });
  });

  test("succeeds when git has forgotten about the worktree (no repoRoot)", async () => {
    const { tempDir, repoDir } = createGitRepo();
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const created = await createLegacyWorktreeForTest({
      branchName: "archive-orphan",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "archive-orphan",
      runSetup: false,
      paseoHome,
    });

    // Simulate a prior failed archive that stripped git's admin dir.
    rmSync(path.join(repoDir, ".git", "worktrees", "archive-orphan"), {
      recursive: true,
      force: true,
    });
    expect(existsSync(created.worktreePath)).toBe(true);

    const emitted: SessionOutboundMessage[] = [];
    await handlePaseoWorktreeArchiveRequest(
      {
        paseoHome,
        github: createGitHubServiceStub(),
        agentManager: {
          listAgents: () => [],
          closeAgent: vi.fn(async () => {}),
        },
        agentStorage: createAgentStorageStub(),
        archiveWorkspaceRecord: vi.fn(async () => {}),
        emit: (msg) => emitted.push(msg),
        emitWorkspaceUpdatesForCwds: vi.fn(async () => {}),
        isPathWithinRoot: createIsPathWithinRoot(),
        killTerminalsUnderPath: vi.fn(async () => {}),
        sessionLogger: createLogger(),
      },
      {
        type: "paseo_worktree_archive_request",
        requestId: "req-archive-orphan",
        worktreePath: created.worktreePath,
      },
    );

    const response = emitted.find(
      (
        message,
      ): message is Extract<SessionOutboundMessage, { type: "paseo_worktree_archive_response" }> =>
        message.type === "paseo_worktree_archive_response",
    );
    expect(response?.payload.success).toBe(true);
    expect(response?.payload.error).toBeNull();
    expect(existsSync(created.worktreePath)).toBe(false);
  });
});
