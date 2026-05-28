import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { AgentManager } from "./agent/agent-manager.js";
import {
  attemptFirstAgentBranchAutoName,
  type AttemptFirstAgentBranchAutoNameResult,
} from "./paseo-worktree-service.js";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";
import { generateBranchNameFromFirstAgentContext } from "./worktree-branch-name-generator.js";
import {
  writePaseoWorktreeFirstAgentBranchAutoNameMetadata,
  writePaseoWorktreeMetadata,
} from "../utils/worktree-metadata.js";

const cleanupPaths: string[] = [];
const PRE_CHANGE_BRANCH_PROMPT = `Generate a git branch name for a coding agent based on the user prompt and attachments.
Branch: concise lowercase slug using letters, numbers, hyphens, and slashes only.
No spaces, no uppercase, no leading or trailing hyphen, no consecutive hyphens.
Return JSON only with a single field 'branch'.

User context:
Fix the login flow`;

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

function createLogger() {
  return {
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("generateBranchNameFromFirstAgentContext", () => {
  test("calls the structured generator with first-agent prompt text", async () => {
    const generateStructured = vi.fn(async () => ({ branch: "fix-login-flow" }));

    const branch = await generateBranchNameFromFirstAgentContext({
      agentManager: {} as AgentManager,
      cwd: "/tmp/repo",
      firstAgentContext: { prompt: "Fix the login flow" },
      logger: createLogger(),
      deps: { generateStructuredAgentResponseWithFallback: generateStructured },
    });

    expect(branch).toBe("fix-login-flow");
    expect(generateStructured).toHaveBeenCalledTimes(1);
    expect(generateStructured.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/tmp/repo",
      schemaName: "BranchName",
      maxRetries: 2,
      agentConfigOverrides: {
        title: "Branch name generator",
        internal: true,
      },
    });
    expect(generateStructured.mock.calls[0]?.[0].prompt).toContain("Fix the login flow");
  });

  test("uses attachment-only context", async () => {
    const generateStructured = vi.fn(async () => ({ branch: "review-flaky-checkout" }));

    const branch = await generateBranchNameFromFirstAgentContext({
      agentManager: {} as AgentManager,
      cwd: "/tmp/repo",
      firstAgentContext: {
        attachments: [
          {
            type: "github_pr",
            mimeType: "application/github-pr",
            number: 42,
            title: "Review flaky checkout",
            url: "https://github.com/acme/repo/pull/42",
          },
        ],
      },
      logger: createLogger(),
      deps: { generateStructuredAgentResponseWithFallback: generateStructured },
    });

    expect(branch).toBe("review-flaky-checkout");
    expect(generateStructured.mock.calls[0]?.[0].prompt).toContain("Review flaky checkout");
  });

  test.each([
    ["paseo.json missing", undefined],
    ["paseo.json exists but invalid JSON", "{ nope"],
    ["paseo.json valid but missing metadataGeneration", {}],
    [
      "metadataGeneration exists but missing branchName",
      { metadataGeneration: { agentTitle: { instructions: "Use mb/." } } },
    ],
    ["branchName exists but instructions is undefined", { metadataGeneration: { branchName: {} } }],
    [
      "branchName exists but instructions is empty",
      { metadataGeneration: { branchName: { instructions: "" } } },
    ],
    [
      "branchName exists but instructions is whitespace-only",
      { metadataGeneration: { branchName: { instructions: "   \n\t " } } },
    ],
  ])("keeps the pre-change prompt byte-identical when %s", async (_name, config) => {
    const { prompt } = await generateBranchPromptWithConfig(config);

    expect(prompt).toBe(PRE_CHANGE_BRANCH_PROMPT);
  });

  test("injects project instructions between the default rules and JSON contract", async () => {
    const { prompt } = await generateBranchPromptWithConfig({
      metadataGeneration: {
        branchName: {
          instructions: "Use the prefix mb/.",
        },
      },
    });

    const defaultRuleIndex = prompt.indexOf("No spaces, no uppercase");
    const noticeIndex = prompt.indexOf("override the guidelines above");
    const openTagIndex = prompt.indexOf("<user-instructions>");
    const userInstructionIndex = prompt.indexOf("Use the prefix mb/.");
    const closeTagIndex = prompt.indexOf("</user-instructions>");
    const jsonContractIndex = prompt.indexOf("Return JSON only");
    const payloadIndex = prompt.indexOf("User context:");

    expect(defaultRuleIndex).toBeGreaterThanOrEqual(0);
    expect(defaultRuleIndex).toBeLessThan(openTagIndex);
    expect(openTagIndex).toBeLessThan(noticeIndex);
    expect(noticeIndex).toBeLessThan(userInstructionIndex);
    expect(userInstructionIndex).toBeLessThan(closeTagIndex);
    expect(closeTagIndex).toBeLessThan(jsonContractIndex);
    expect(jsonContractIndex).toBeLessThan(payloadIndex);
  });

  test("keeps the branch slug validator fallback when instructions are present", async () => {
    const repoRoot = createTempDir("paseo-branch-config-");
    const worktreeRoot = createTempDir("paseo-branch-worktree-");
    mkdirSync(path.join(worktreeRoot, ".git"));
    writePaseoWorktreeMetadata(worktreeRoot, { baseRefName: "main" });
    writePaseoWorktreeFirstAgentBranchAutoNameMetadata(worktreeRoot, {
      placeholderBranchName: "dazzling-yak",
    });
    writeConfig(repoRoot, {
      metadataGeneration: {
        branchName: {
          instructions: "Use the prefix mb/.",
        },
      },
    });
    const generateStructured = vi.fn(async () => ({ branch: "Invalid Branch Name" }));
    const renameCurrentBranch = vi.fn(async () => ({ currentBranch: "Invalid Branch Name" }));

    const result: AttemptFirstAgentBranchAutoNameResult = await attemptFirstAgentBranchAutoName({
      cwd: worktreeRoot,
      firstAgentContext: { prompt: "Fix the login flow" },
      generateBranchNameFromContext: ({ cwd, firstAgentContext }) =>
        generateBranchNameFromFirstAgentContext({
          agentManager: {} as AgentManager,
          cwd,
          workspaceGitService: createNoopWorkspaceGitService({
            resolveRepoRoot: async () => repoRoot,
          }),
          firstAgentContext,
          logger: createLogger(),
          deps: { generateStructuredAgentResponseWithFallback: generateStructured },
        }),
      getCurrentBranch: async () => "dazzling-yak",
      renameCurrentBranch,
    });

    expect(result).toEqual({ attempted: true, renamed: false, branchName: null });
    expect(renameCurrentBranch).not.toHaveBeenCalled();
  });
});

async function generateBranchPromptWithConfig(config: unknown): Promise<{ prompt: string }> {
  const repoRoot = createTempDir("paseo-branch-config-");
  if (typeof config === "string") {
    writeFileSync(path.join(repoRoot, "paseo.json"), config);
  } else if (config !== undefined) {
    writeConfig(repoRoot, config);
  }

  const generateStructured = vi.fn(async () => ({ branch: "fix-login-flow" }));

  await generateBranchNameFromFirstAgentContext({
    agentManager: {} as AgentManager,
    cwd: path.join(repoRoot, "nested"),
    workspaceGitService: createNoopWorkspaceGitService({
      resolveRepoRoot: async () => repoRoot,
    }),
    firstAgentContext: { prompt: "Fix the login flow" },
    logger: createLogger(),
    deps: { generateStructuredAgentResponseWithFallback: generateStructured },
  });

  return {
    prompt: String(generateStructured.mock.calls[0]?.[0].prompt),
  };
}

function createTempDir(prefix: string): string {
  const tempDir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanupPaths.push(tempDir);
  return tempDir;
}

function writeConfig(repoRoot: string, config: unknown): void {
  writeFileSync(path.join(repoRoot, "paseo.json"), `${JSON.stringify(config)}\n`);
}
