import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { createNoopWorkspaceGitService } from "../test-utils/workspace-git-service-stub.js";
import { MAX_AUTO_AGENT_TITLE_CHARS } from "./agent-title-limits.js";
import {
  generateAndApplyAgentMetadata,
  type AgentMetadataGeneratorDeps,
} from "./agent-metadata-generator.js";
import type { AgentManager } from "./agent-manager.js";

const logger = createTestLogger();
const cleanupPaths: string[] = [];
const PRE_CHANGE_TITLE_PROMPT = `Generate metadata for a coding agent based on the user prompt.
Title: short descriptive label (<= ${MAX_AUTO_AGENT_TITLE_CHARS} chars).
Return JSON only with a single field 'title'.

User prompt:
Implement this feature`;

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

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

  it.each([
    ["paseo.json missing", undefined],
    ["paseo.json exists but invalid JSON", "{ nope"],
    ["paseo.json valid but missing metadataGeneration", {}],
    [
      "metadataGeneration exists but missing agentTitle",
      { metadataGeneration: { branchName: { instructions: "Use mb/." } } },
    ],
    ["agentTitle exists but instructions is undefined", { metadataGeneration: { agentTitle: {} } }],
    [
      "agentTitle exists but instructions is empty",
      { metadataGeneration: { agentTitle: { instructions: "" } } },
    ],
    [
      "agentTitle exists but instructions is whitespace-only",
      { metadataGeneration: { agentTitle: { instructions: "   \n\t " } } },
    ],
  ])("keeps the pre-change prompt byte-identical when %s", async (_name, config) => {
    const { prompt } = await generateTitlePromptWithConfig(config);

    expect(prompt).toBe(PRE_CHANGE_TITLE_PROMPT);
  });

  it("injects project instructions between the default rules and JSON contract", async () => {
    const { prompt } = await generateTitlePromptWithConfig({
      metadataGeneration: {
        agentTitle: {
          instructions: "Use the prefix mb/.",
        },
      },
    });

    const defaultRuleIndex = prompt.indexOf("Title: short descriptive label");
    const noticeIndex = prompt.indexOf("override the guidelines above");
    const openTagIndex = prompt.indexOf("<user-instructions>");
    const userInstructionIndex = prompt.indexOf("Use the prefix mb/.");
    const closeTagIndex = prompt.indexOf("</user-instructions>");
    const jsonContractIndex = prompt.indexOf("Return JSON only");
    const payloadIndex = prompt.indexOf("User prompt:");

    expect(defaultRuleIndex).toBeGreaterThanOrEqual(0);
    expect(defaultRuleIndex).toBeLessThan(openTagIndex);
    expect(openTagIndex).toBeLessThan(noticeIndex);
    expect(noticeIndex).toBeLessThan(userInstructionIndex);
    expect(userInstructionIndex).toBeLessThan(closeTagIndex);
    expect(closeTagIndex).toBeLessThan(jsonContractIndex);
    expect(jsonContractIndex).toBeLessThan(payloadIndex);
  });
});

async function generateTitlePromptWithConfig(config: unknown): Promise<{ prompt: string }> {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "paseo-title-config-"));
  cleanupPaths.push(repoRoot);
  if (typeof config === "string") {
    writeFileSync(path.join(repoRoot, "paseo.json"), config);
  } else if (config !== undefined) {
    writeFileSync(path.join(repoRoot, "paseo.json"), `${JSON.stringify(config)}\n`);
  }

  const setTitle = vi.fn().mockResolvedValue(undefined);
  const manager = { setTitle } as unknown as AgentManager;
  const generateStructured = vi.fn().mockResolvedValue({ title: "Generated title" }) as NonNullable<
    AgentMetadataGeneratorDeps["generateStructuredAgentResponseWithFallback"]
  >;

  await generateAndApplyAgentMetadata({
    agentManager: manager,
    agentId: "agent-config",
    cwd: path.join(repoRoot, "nested"),
    workspaceGitService: createNoopWorkspaceGitService({
      resolveRepoRoot: async () => repoRoot,
    }),
    initialPrompt: "Implement this feature",
    explicitTitle: null,
    logger,
    deps: createDeps(generateStructured),
  });

  return {
    prompt: String(generateStructured.mock.calls[0]?.[0].prompt),
  };
}
