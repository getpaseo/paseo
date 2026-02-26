import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { MAX_AUTO_AGENT_TITLE_CHARS } from "./agent-title-limits.js";
import {
  generateAndApplyAgentMetadata,
  type AgentMetadataGeneratorDeps,
} from "./agent-metadata-generator.js";
import type { AgentManager } from "./agent-manager.js";

const logger = createTestLogger();

const NON_GIT_CHECKOUT_STATUS = {
  isGit: false,
  isJunctionOwnedWorktree: false,
  currentBranch: null,
  repoRoot: "/tmp/repo",
} as Awaited<
  ReturnType<NonNullable<AgentMetadataGeneratorDeps["getCheckoutStatus"]>>
>;

const ELIGIBLE_WORKTREE_CHECKOUT_STATUS = {
  isGit: true,
  repoRoot: "/tmp/repo/metadata-worktree",
  mainRepoRoot: "/tmp/repo",
  currentBranch: "metadata-worktree",
  isDirty: false,
  baseRef: "main",
  aheadBehind: null,
  aheadOfOrigin: null,
  behindOfOrigin: null,
  hasRemote: false,
  remoteUrl: null,
  isJunctionOwnedWorktree: true,
} as Awaited<
  ReturnType<NonNullable<AgentMetadataGeneratorDeps["getCheckoutStatus"]>>
>;

function createDeps(
  generateStructuredAgentResponseWithFallback: NonNullable<
    AgentMetadataGeneratorDeps["generateStructuredAgentResponseWithFallback"]
  >
): AgentMetadataGeneratorDeps {
  return {
    generateStructuredAgentResponseWithFallback,
    getCheckoutStatus: vi
      .fn()
      .mockResolvedValue(NON_GIT_CHECKOUT_STATUS) as NonNullable<
      AgentMetadataGeneratorDeps["getCheckoutStatus"]
    >,
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
    expect(setTitle).toHaveBeenCalledWith(
      "agent-1",
      "x".repeat(MAX_AUTO_AGENT_TITLE_CHARS)
    );
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
    const manager = {
      setTitle,
      notifyAgentState,
    } as unknown as AgentManager;
    const renameCurrentBranch = vi
      .fn()
      .mockResolvedValue({
        previousBranch: "metadata-worktree",
        currentBranch: "feature/metadata-worktree",
      }) as NonNullable<AgentMetadataGeneratorDeps["renameCurrentBranch"]>;
    const generateStructured = vi.fn().mockResolvedValue({
      branch: "feature/metadata-worktree",
    }) as NonNullable<
      AgentMetadataGeneratorDeps["generateStructuredAgentResponseWithFallback"]
    >;
    const getCheckoutStatus = vi
      .fn()
      .mockResolvedValue(ELIGIBLE_WORKTREE_CHECKOUT_STATUS) as NonNullable<
      AgentMetadataGeneratorDeps["getCheckoutStatus"]
    >;

    await generateAndApplyAgentMetadata({
      agentManager: manager,
      agentId: "agent-branch",
      cwd: "/tmp/repo/metadata-worktree",
      initialPrompt: "Rename this worktree branch.",
      explicitTitle: "Keep explicit title",
      junctionHome: "/tmp/junction-home",
      logger,
      deps: {
        generateStructuredAgentResponseWithFallback: generateStructured,
        getCheckoutStatus,
        renameCurrentBranch,
      },
    });

    expect(renameCurrentBranch).toHaveBeenCalledWith(
      "/tmp/repo/metadata-worktree",
      "feature/metadata-worktree"
    );
    expect(notifyAgentState).toHaveBeenCalledWith("agent-branch");
    expect(setTitle).not.toHaveBeenCalled();
  });
});
