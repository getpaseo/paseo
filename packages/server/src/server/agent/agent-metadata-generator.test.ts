import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentManager } from "./agent-manager.js";
import {
  determineAgentMetadataNeeds,
  generateAndApplyAgentMetadata,
  scheduleAgentMetadataGeneration,
} from "./agent-metadata-generator.js";

const logger = createTestLogger();

function createAgentManagerStub() {
  return {
    setTitle: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentManager;
}

function delayImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function getSchemaKeys(schema: unknown): string[] {
  const shape =
    (schema as { shape?: Record<string, unknown> }).shape ??
    (schema as { _def?: { shape?: () => Record<string, unknown> } })._def?.shape?.();
  return shape ? Object.keys(shape).sort() : [];
}

describe("agent metadata generation", () => {
  it("skips generation when there is no initial prompt", async () => {
    const agentManager = createAgentManagerStub();
    const generator = vi.fn();

    await generateAndApplyAgentMetadata({
      agentManager,
      agentId: "agent-1",
      cwd: "/tmp",
      initialPrompt: "   ",
      logger,
      deps: { generateStructuredAgentResponse: generator },
    });

    expect(generator).not.toHaveBeenCalled();
  });

  it("determines title needs when explicit title is missing", async () => {
    const needs = await determineAgentMetadataNeeds({
      cwd: "/tmp",
      initialPrompt: "Do the thing",
      explicitTitle: null,
      deps: {
        getCheckoutStatus: async () => ({
          isGit: false,
        }),
      },
    });

    expect(needs.needsTitle).toBe(true);
    expect(needs.needsBranch).toBe(false);
  });

  it("schedules async title generation", async () => {
    const agentManager = createAgentManagerStub();
    const generator = vi.fn(async () => ({ title: "Generated Title" }));

    scheduleAgentMetadataGeneration({
      agentManager,
      agentId: "agent-2",
      cwd: "/tmp",
      initialPrompt: "Create a report",
      explicitTitle: null,
      logger,
      deps: {
        generateStructuredAgentResponse: generator,
        getCheckoutStatus: async () => ({
          isGit: false,
        }),
      },
    });

    expect(generator).not.toHaveBeenCalled();

    await delayImmediate();

    expect(generator).toHaveBeenCalledTimes(1);
    expect(agentManager.setTitle).toHaveBeenCalledWith(
      "agent-2",
      "Generated Title"
    );
  });

  it("selects title-only schema when branch is not eligible", async () => {
    const agentManager = createAgentManagerStub();
    let capturedSchema: unknown;
    const generator = vi.fn(async (options: any) => {
      capturedSchema = options.schema;
      return { title: "Only Title" };
    });

    await generateAndApplyAgentMetadata({
      agentManager,
      agentId: "agent-title-only",
      cwd: "/tmp",
      initialPrompt: "Do the thing",
      explicitTitle: null,
      logger,
      deps: {
        generateStructuredAgentResponse: generator,
        getCheckoutStatus: async () => ({
          isGit: false,
        }),
      },
    });

    expect(getSchemaKeys(capturedSchema)).toEqual(["title"]);
  });

  it("selects branch-only schema when explicit title exists and branch is eligible", async () => {
    const agentManager = createAgentManagerStub();
    let capturedSchema: unknown;
    const generator = vi.fn(async (options: any) => {
      capturedSchema = options.schema;
      return { branch: "feat/branch-only" };
    });
    const renameCurrentBranch = vi.fn().mockResolvedValue({
      previousBranch: "worktree-name",
      currentBranch: "feat/branch-only",
    });

    await generateAndApplyAgentMetadata({
      agentManager,
      agentId: "agent-branch-only",
      cwd: "/tmp/worktree",
      initialPrompt: "Add feature",
      explicitTitle: "Explicit Title",
      logger,
      deps: {
        generateStructuredAgentResponse: generator,
        getCheckoutStatus: async () => ({
          isGit: true,
          isPaseoOwnedWorktree: true,
          repoRoot: "/tmp/worktree-name",
          mainRepoRoot: "/tmp/main",
          currentBranch: "worktree-name",
          isDirty: false,
          baseRef: "main",
          aheadBehind: null,
          aheadOfOrigin: null,
          hasRemote: false,
          remoteUrl: null,
        }),
        renameCurrentBranch,
      },
    });

    expect(getSchemaKeys(capturedSchema)).toEqual(["branch"]);
    expect(agentManager.setTitle).not.toHaveBeenCalled();
  });

  it("selects title+branch schema when both are needed", async () => {
    const agentManager = createAgentManagerStub();
    let capturedSchema: unknown;
    const generator = vi.fn(async (options: any) => {
      capturedSchema = options.schema;
      return { title: "Both", branch: "feat/both" };
    });
    const renameCurrentBranch = vi.fn().mockResolvedValue({
      previousBranch: "worktree-name",
      currentBranch: "feat/both",
    });

    await generateAndApplyAgentMetadata({
      agentManager,
      agentId: "agent-both",
      cwd: "/tmp/worktree",
      initialPrompt: "Add payment support",
      explicitTitle: null,
      logger,
      deps: {
        generateStructuredAgentResponse: generator,
        getCheckoutStatus: async () => ({
          isGit: true,
          isPaseoOwnedWorktree: true,
          repoRoot: "/tmp/worktree-name",
          mainRepoRoot: "/tmp/main",
          currentBranch: "worktree-name",
          isDirty: false,
          baseRef: "main",
          aheadBehind: null,
          aheadOfOrigin: null,
          hasRemote: false,
          remoteUrl: null,
        }),
        renameCurrentBranch,
      },
    });

    expect(getSchemaKeys(capturedSchema)).toEqual(["branch", "title"]);
  });

  it("renames branch when eligible, even with explicit title", async () => {
    const agentManager = createAgentManagerStub();
    const generator = vi.fn(async () => ({ branch: "feat/auto-branch" }));
    const renameCurrentBranch = vi.fn().mockResolvedValue({
      previousBranch: "worktree-name",
      currentBranch: "feat/auto-branch",
    });

    await generateAndApplyAgentMetadata({
      agentManager,
      agentId: "agent-3",
      cwd: "/tmp/worktree",
      initialPrompt: "Add payment support",
      explicitTitle: "Payments",
      logger,
      deps: {
        generateStructuredAgentResponse: generator,
        getCheckoutStatus: async () => ({
          isGit: true,
          isPaseoOwnedWorktree: true,
          repoRoot: "/tmp/worktree-name",
          mainRepoRoot: "/tmp/main",
          currentBranch: "worktree-name",
          isDirty: false,
          baseRef: "main",
          aheadBehind: null,
          aheadOfOrigin: null,
          hasRemote: false,
          remoteUrl: null,
        }),
        renameCurrentBranch,
      },
    });

    expect(generator).toHaveBeenCalledTimes(1);
    expect(renameCurrentBranch).toHaveBeenCalledWith(
      "/tmp/worktree",
      "feat/auto-branch"
    );
  });

  it("skips rename when generated branch is invalid", async () => {
    const agentManager = createAgentManagerStub();
    const generator = vi.fn(async () => ({ branch: "Invalid Branch" }));
    const renameCurrentBranch = vi.fn();

    await generateAndApplyAgentMetadata({
      agentManager,
      agentId: "agent-invalid-branch",
      cwd: "/tmp/worktree",
      initialPrompt: "Ship it",
      explicitTitle: "Explicit",
      logger,
      deps: {
        generateStructuredAgentResponse: generator,
        getCheckoutStatus: async () => ({
          isGit: true,
          isPaseoOwnedWorktree: true,
          repoRoot: "/tmp/worktree-name",
          mainRepoRoot: "/tmp/main",
          currentBranch: "worktree-name",
          isDirty: false,
          baseRef: "main",
          aheadBehind: null,
          aheadOfOrigin: null,
          hasRemote: false,
          remoteUrl: null,
        }),
        renameCurrentBranch,
      },
    });

    expect(renameCurrentBranch).not.toHaveBeenCalled();
  });

  it("schedules async branch generation for worktree agents", async () => {
    const agentManager = createAgentManagerStub();
    const generator = vi.fn(async () => ({ branch: "feat/async-branch" }));
    const renameCurrentBranch = vi.fn().mockResolvedValue({
      previousBranch: "worktree-name",
      currentBranch: "feat/async-branch",
    });

    scheduleAgentMetadataGeneration({
      agentManager,
      agentId: "agent-4",
      cwd: "/tmp/worktree",
      initialPrompt: "Ship the feature",
      explicitTitle: "Explicit Title",
      logger,
      deps: {
        generateStructuredAgentResponse: generator,
        getCheckoutStatus: async () => ({
          isGit: true,
          isPaseoOwnedWorktree: true,
          repoRoot: "/tmp/worktree-name",
          mainRepoRoot: "/tmp/main",
          currentBranch: "worktree-name",
          isDirty: false,
          baseRef: "main",
          aheadBehind: null,
          aheadOfOrigin: null,
          hasRemote: false,
          remoteUrl: null,
        }),
        renameCurrentBranch,
      },
    });

    expect(generator).not.toHaveBeenCalled();

    await delayImmediate();

    expect(generator).toHaveBeenCalledTimes(1);
    expect(renameCurrentBranch).toHaveBeenCalledWith(
      "/tmp/worktree",
      "feat/async-branch"
    );
  });
});
