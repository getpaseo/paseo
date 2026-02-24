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
  isPaseoOwnedWorktree: false,
  currentBranch: null,
  repoRoot: "/tmp/repo",
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
});
