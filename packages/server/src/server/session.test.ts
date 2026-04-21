import { execSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { CheckoutPrStatusSchema } from "../shared/messages.js";
import { normalizeCheckoutPrStatusPayload, Session } from "./session.js";

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

const spawnMocks = vi.hoisted(() => ({
  execCommand: vi.fn(),
  spawnWorkspaceScript: vi.fn(),
}));

const paseoWorktreeServiceMocks = vi.hoisted(() => ({
  createPaseoWorktree: vi.fn(),
}));

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

vi.mock("./worktree-bootstrap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./worktree-bootstrap.js")>();
  return {
    ...actual,
    spawnWorkspaceScript: spawnMocks.spawnWorkspaceScript,
  };
});

function createSessionForTest(options?: {
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
    getWorkspaceGitMetadata?: ReturnType<typeof vi.fn>;
  };
  workspaceRegistry?: { get: ReturnType<typeof vi.fn> };
  terminalManager?: unknown;
  scriptRouteStore?: unknown;
  scriptRuntimeStore?: unknown;
  getDaemonTcpPort?: () => number | null;
  getDaemonTcpHost?: () => string | null;
  messages?: unknown[];
}): Session {
  const logger = pino({ level: "silent" });
  const github = options?.github ?? {
    invalidate: vi.fn(),
    searchIssuesAndPrs: vi.fn(),
    createPullRequest: vi.fn(),
  };
  const checkoutDiffManager = options?.checkoutDiffManager ?? {
    scheduleRefreshForCwd: vi.fn(),
  };
  const workspaceGitService = options?.workspaceGitService ?? {
    getCheckoutDiff: vi.fn(),
    getSnapshot: vi.fn(),
    suggestBranchesForCwd: vi.fn(),
    listStashes: vi.fn(),
    peekSnapshot: vi.fn(),
    validateBranchRef: vi.fn(),
    hasLocalBranch: vi.fn(),
    resolveRepoRemoteUrl: vi.fn(),
    getWorkspaceGitMetadata: vi.fn(),
  };
  const messages = options?.messages ?? [];

  return new Session({
    clientId: "test-client",
    onMessage: (message) => messages.push(message),
    logger,
    downloadTokenStore: {} as any,
    pushTokenStore: {} as any,
    paseoHome: "/tmp/paseo-home",
    agentManager: {
      subscribe: vi.fn(() => () => {}),
    } as any,
    agentStorage: {} as any,
    projectRegistry: {} as any,
    workspaceRegistry:
      options?.workspaceRegistry ??
      ({
        get: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
      } as any),
    chatService: {} as any,
    scheduleService: {} as any,
    loopService: {} as any,
    checkoutDiffManager: checkoutDiffManager as any,
    github: github as any,
    workspaceGitService: workspaceGitService as any,
    daemonConfigStore: {} as any,
    stt: null,
    tts: null,
    terminalManager: (options?.terminalManager ?? null) as any,
    scriptRouteStore: options?.scriptRouteStore as any,
    scriptRuntimeStore: options?.scriptRuntimeStore as any,
    getDaemonTcpPort: options?.getDaemonTcpPort,
    getDaemonTcpHost: options?.getDaemonTcpHost,
  });
}

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
      refreshedAt: null,
      ...overrides?.github,
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("session PR status payload normalization", () => {
  test("includes repository identity fields on the wire", () => {
    const payload = normalizeCheckoutPrStatusPayload({
      number: 123,
      repoOwner: "internal-owner",
      repoName: "internal-repo",
      url: "https://github.com/getpaseo/paseo/pull/123",
      title: "Ship PR pane",
      state: "open",
      baseRefName: "main",
      headRefName: "feature/pr-pane",
      isMerged: false,
      isDraft: true,
      checks: [
        {
          name: "typecheck",
          status: "success",
          url: "https://github.com/getpaseo/paseo/actions/runs/1",
          workflow: "CI",
          duration: "1m 20s",
        },
      ],
      checksStatus: "success",
      reviewDecision: "approved",
    });

    expect(payload).toHaveProperty("repoOwner", "internal-owner");
    expect(payload).toHaveProperty("repoName", "internal-repo");
    expect(CheckoutPrStatusSchema.parse(payload)).toEqual(payload);
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

    await (session as any).handleCheckoutMergeRequest({
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

    await (session as any).handleCheckoutMergeFromBaseRequest({
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

    await (session as any).handleCheckoutMergeFromBaseRequest({
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
  test("forces a workspace git snapshot refresh after committing", async () => {
    const messages: unknown[] = [];
    const checkoutDiffManager = { scheduleRefreshForCwd: vi.fn() };
    const workspaceGitService = { getSnapshot: vi.fn().mockResolvedValue({}) };
    const session = createSessionForTest({ checkoutDiffManager, workspaceGitService, messages });

    checkoutGitMocks.commitChanges.mockResolvedValue(undefined);

    await (session as any).handleCheckoutCommitRequest({
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

    await (session as any).handleCheckoutCommitRequest({
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

  test("does not force a workspace git snapshot refresh when commit fails", async () => {
    const messages: unknown[] = [];
    const workspaceGitService = { getSnapshot: vi.fn().mockResolvedValue({}) };
    const session = createSessionForTest({ workspaceGitService, messages });
    checkoutGitMocks.commitChanges.mockRejectedValue(new Error("nothing to commit"));

    await (session as any).handleCheckoutCommitRequest({
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

    await (session as any).handleCheckoutPrCreateRequest({
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
    expect(checkoutGitMocks.createPullRequest).toHaveBeenCalledWith(
      "/tmp/request-worktree",
      {
        title: "Update file",
        body: "Updates file.",
        base: "main",
      },
      expect.anything(),
      expect.objectContaining({
        getCheckoutDiff: workspaceGitService.getCheckoutDiff,
      }),
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

    await (session as any).handleCheckoutPrCreateRequest({
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

describe("session checkout pull and push handling", () => {
  test("forces workspace git and GitHub refresh after pulling", async () => {
    const messages: unknown[] = [];
    const github = { invalidate: vi.fn() };
    const workspaceGitService = { getSnapshot: vi.fn().mockResolvedValue({}) };
    const session = createSessionForTest({ github, workspaceGitService, messages });
    checkoutGitMocks.pullCurrentBranch.mockResolvedValue(undefined);

    await (session as any).handleCheckoutPullRequest({
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

    await (session as any).handleCheckoutPushRequest({
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

    await (session as any).handleCheckoutStatusRequest({
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

    await (session as any).handleCheckoutStatusRequest({
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

    const descriptor = await (session as any).describeWorkspaceRecord(
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

    const descriptor = await (session as any).describeWorkspaceRecordWithGitData(
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

    await (session as any).handleValidateBranchRequest({
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
      (session as any).createBranchFromBase({
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
      (session as any).createBranchFromBase({
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

    await (session as any).createBranchFromBase({
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

    await (session as any).handleCheckoutSwitchBranchRequest({
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

    await (session as any).handleBranchSuggestionsRequest({
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

    await (session as any).handleStashListRequest({
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

    await (session as any).handleStashSaveRequest({
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

    await (session as any).handleStashPopRequest({
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

    await (session as any).createPaseoWorktree({
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

    await (session as any).handleStartWorkspaceScriptRequest({
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
