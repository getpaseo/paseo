import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { MAX_AUTO_AGENT_TITLE_CHARS } from "./agent-title-limits.js";
import {
  generateAndApplyAgentMetadata,
  type AgentMetadataGeneratorDeps,
} from "./agent-metadata-generator.js";
import type { AgentManager } from "./agent-manager.js";
import type { WorkspaceGitRuntimeSnapshot } from "../workspace-git-service.js";

const logger = createTestLogger();

const ELIGIBLE_WORKTREE_SNAPSHOT: WorkspaceGitRuntimeSnapshot = {
  cwd: "/tmp/repo/metadata-worktree",
  git: {
    isGit: true,
    repoRoot: "/tmp/repo/metadata-worktree",
    mainRepoRoot: "/tmp/repo",
    currentBranch: "metadata-worktree",
    remoteUrl: null,
    isPaseoOwnedWorktree: true,
    isDirty: false,
    baseRef: "main",
    aheadBehind: null,
    aheadOfOrigin: null,
    behindOfOrigin: null,
    hasRemote: false,
    diffStat: null,
  },
  github: {
    featuresEnabled: false,
    pullRequest: null,
    error: null,
  },
};

function createDeps(
  generateStructuredAgentResponseWithFallback: NonNullable<
    AgentMetadataGeneratorDeps["generateStructuredAgentResponseWithFallback"]
  >,
): AgentMetadataGeneratorDeps {
  return {
    generateStructuredAgentResponseWithFallback,
  };
}

describe("agent metadata generator auto-title", () => {
  it("caps generated auto titles at 40 characters before persisting", async () => {
    const setTitle = vi.fn().mockResolvedValue(undefined);
    const manager = { setTitle } as unknown as AgentManager;
    const generatedTitle = "x".repeat(MAX_AUTO_AGENT_TITLE_CHARS + 25);
    const generateStructured = vi.fn().mockResolvedValue({ title: generatedTitle }) as NonNullable<
      AgentMetadataGeneratorDeps["generateStructuredAgentResponseWithFallback"]
    >;

    await generateAndApplyAgentMetadata({
      agentManager: manager,
      agentId: "agent-1",
      cwd: "/tmp/repo",
      initialPrompt: "Implement this feature",
      explicitTitle: null,
      logger,
      deps: createDeps(generateStructured),
    });

    expect(setTitle).toHaveBeenCalledTimes(1);
    expect(setTitle).toHaveBeenCalledWith("agent-1", "x".repeat(MAX_AUTO_AGENT_TITLE_CHARS));
  });

  it("does not generate an auto title when an explicit title is provided", async () => {
    const setTitle = vi.fn().mockResolvedValue(undefined);
    const manager = { setTitle } as unknown as AgentManager;
    const generateStructured = vi.fn().mockResolvedValue({ title: "Generated" }) as NonNullable<
      AgentMetadataGeneratorDeps["generateStructuredAgentResponseWithFallback"]
    >;

    await generateAndApplyAgentMetadata({
      agentManager: manager,
      agentId: "agent-2",
      cwd: "/tmp/repo",
      initialPrompt: "Implement this feature",
      explicitTitle: "Keep this title",
      logger,
      deps: createDeps(generateStructured),
    });

    expect(generateStructured).not.toHaveBeenCalled();
    expect(setTitle).not.toHaveBeenCalled();
  });

  it("notifies agent state after successfully renaming a generated branch", async () => {
    const setTitle = vi.fn().mockResolvedValue(undefined);
    const notifyAgentState = vi.fn();
    const flush = vi.fn().mockResolvedValue(undefined);
    const manager = {
      setTitle,
      notifyAgentState,
      flush,
    } as unknown as AgentManager;
    const renameCurrentBranch = vi.fn().mockResolvedValue({
      previousBranch: "metadata-worktree",
      currentBranch: "feature/metadata-worktree",
    }) as NonNullable<AgentMetadataGeneratorDeps["renameCurrentBranch"]>;
    const generateStructured = vi.fn().mockResolvedValue({
      branch: "feature/metadata-worktree",
    }) as NonNullable<AgentMetadataGeneratorDeps["generateStructuredAgentResponseWithFallback"]>;
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue(ELIGIBLE_WORKTREE_SNAPSHOT),
    };

    await generateAndApplyAgentMetadata({
      agentManager: manager,
      agentId: "agent-branch",
      cwd: "/tmp/repo/metadata-worktree",
      initialPrompt: "Rename this worktree branch.",
      explicitTitle: "Keep explicit title",
      paseoHome: "/tmp/paseo-home",
      logger,
      deps: {
        generateStructuredAgentResponseWithFallback: generateStructured,
        renameCurrentBranch,
        workspaceGitService,
      },
    });

    expect(renameCurrentBranch).toHaveBeenCalledWith(
      "/tmp/repo/metadata-worktree",
      "feature/metadata-worktree",
    );
    expect(notifyAgentState).toHaveBeenCalledWith("agent-branch");
    expect(setTitle).not.toHaveBeenCalled();
  });

  it("forces a workspace git snapshot refresh after renaming a generated branch", async () => {
    const manager = {
      setTitle: vi.fn().mockResolvedValue(undefined),
      notifyAgentState: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentManager;
    const renameCurrentBranch = vi.fn().mockResolvedValue({
      previousBranch: "metadata-worktree",
      currentBranch: "feature/metadata-worktree",
    }) as NonNullable<AgentMetadataGeneratorDeps["renameCurrentBranch"]>;
    const generateStructured = vi.fn().mockResolvedValue({
      branch: "feature/metadata-worktree",
    }) as NonNullable<AgentMetadataGeneratorDeps["generateStructuredAgentResponseWithFallback"]>;
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue(ELIGIBLE_WORKTREE_SNAPSHOT),
    };

    await generateAndApplyAgentMetadata({
      agentManager: manager,
      agentId: "agent-branch-refresh",
      cwd: "/tmp/repo/metadata-worktree",
      initialPrompt: "Rename this worktree branch.",
      explicitTitle: "Keep explicit title",
      logger,
      deps: {
        generateStructuredAgentResponseWithFallback: generateStructured,
        renameCurrentBranch,
        workspaceGitService: workspaceGitService as any,
      },
    });

    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/repo/metadata-worktree", {
      force: true,
      reason: "rename-branch",
    });
  });

  it("uses the workspace git service snapshot for branch rename eligibility checks", async () => {
    const setTitle = vi.fn().mockResolvedValue(undefined);
    const notifyAgentState = vi.fn();
    const manager = {
      setTitle,
      notifyAgentState,
      flush: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentManager;
    const workspaceGitService = {
      getSnapshot: vi.fn().mockResolvedValue(ELIGIBLE_WORKTREE_SNAPSHOT),
    };
    const renameCurrentBranch = vi.fn().mockResolvedValue({
      previousBranch: "metadata-worktree",
      currentBranch: "feature/metadata-worktree",
    }) as NonNullable<AgentMetadataGeneratorDeps["renameCurrentBranch"]>;
    const generateStructured = vi.fn().mockResolvedValue({
      branch: "feature/metadata-worktree",
    }) as NonNullable<AgentMetadataGeneratorDeps["generateStructuredAgentResponseWithFallback"]>;

    await generateAndApplyAgentMetadata({
      agentManager: manager,
      agentId: "agent-service-branch",
      cwd: "/tmp/repo/metadata-worktree",
      initialPrompt: "Rename this worktree branch.",
      explicitTitle: "Keep explicit title",
      logger,
      deps: {
        generateStructuredAgentResponseWithFallback: generateStructured,
        renameCurrentBranch,
        workspaceGitService: workspaceGitService as any,
      },
    });

    expect(workspaceGitService.getSnapshot).toHaveBeenCalledTimes(3);
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/repo/metadata-worktree");
    expect(workspaceGitService.getSnapshot).toHaveBeenCalledWith("/tmp/repo/metadata-worktree", {
      force: true,
      reason: "rename-branch",
    });
    expect(renameCurrentBranch).toHaveBeenCalledWith(
      "/tmp/repo/metadata-worktree",
      "feature/metadata-worktree",
    );
  });
});
