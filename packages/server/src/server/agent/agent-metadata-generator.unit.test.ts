import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { MAX_AUTO_AGENT_TITLE_CHARS } from "./agent-title-limits.js";
import {
  generateAndApplyAgentMetadata,
  type AgentMetadataGeneratorDeps,
} from "./agent-metadata-generator.js";
import type { AgentManager } from "./agent-manager.js";

const logger = createTestLogger();

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

  it("generates titles independently from workspace branch naming", async () => {
    const setTitle = vi.fn().mockResolvedValue(undefined);
    const manager = { setTitle } as unknown as AgentManager;
    const generateStructured = vi
      .fn()
      .mockResolvedValue({ title: "Generated title" }) as NonNullable<
      AgentMetadataGeneratorDeps["generateStructuredAgentResponseWithFallback"]
    >;

    await generateAndApplyAgentMetadata({
      agentManager: manager,
      agentId: "agent-suppressed-branch",
      cwd: "/tmp/repo/metadata-worktree",
      initialPrompt: "Implement this feature",
      explicitTitle: null,
      logger,
      deps: {
        generateStructuredAgentResponseWithFallback: generateStructured,
      },
    });

    expect(generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/repo/metadata-worktree",
        persistSession: false,
      }),
    );
    expect(setTitle).toHaveBeenCalledWith("agent-suppressed-branch", "Generated title");
  });
});
