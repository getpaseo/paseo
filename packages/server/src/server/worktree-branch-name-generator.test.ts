import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { AgentManager } from "./agent/agent-manager.js";
import type { StructuredAgentGenerationWithFallbackOptions } from "./agent/agent-response-loop.js";
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
const BRANCH_PROMPT_BASELINE = `Generate a title and a git branch name for a coding agent from the user prompt and attachments.
The branch must be a valid git ref: lowercase letters, numbers, hyphens, and slashes only, with no spaces, no uppercase, no leading or trailing hyphen, and no consecutive hyphens.
The branch is generated directly from the prompt — it is NEVER derived from or slugified from the title.

Title style:
A terse, task-shaped label naming what the task is about (sentence case, max 80 characters).
Aim for about 4 words. Go longer only when the task genuinely needs it; most titles must stay short.
Do not start with a generic 'do' verb (Fix, Add, Implement, Diagnose, Update, Change, Create, Set, Make) — every task is implicitly one of these, so the verb is noise. Name the thing instead.
Keep a verb only when it states the specific operation (Swap, Split, Extract, Rename, Merge, Inline).
Good titles: "Swap sidebar history icon", "Composer keyboard shift", "Agent auto-titling", "Worktree selection memory", "Split browser pane".
Bad titles: "Fix composer pushed up by keyboard in workspace", "Diagnose auto-titling still happening for agents", "Change sidebar history icon from clock to history icon".

Branch style:
A short, descriptive slug — a few lowercase words joined by hyphens.

Return JSON only with fields 'title' and 'branch'.

User context:
Fix the login flow`;

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createStructuredGenerator(result: { title: string; branch: string }) {
  const calls: StructuredAgentGenerationWithFallbackOptions<unknown>[] = [];

  async function generateStructured<T>(
    options: StructuredAgentGenerationWithFallbackOptions<T>,
  ): Promise<T> {
    calls.push(options as StructuredAgentGenerationWithFallbackOptions<unknown>);
    return result as T;
  }

  return { generateStructured, calls };
}

describe("generateBranchNameFromFirstAgentContext", () => {
  test("returns title and branch independently — branch is not a slug of the title", async () => {
    const structured = createStructuredGenerator({
      title: "Add payments flow",
      branch: "pay/checkout",
    });

    const result = await generateBranchNameFromFirstAgentContext({
      agentManager: {} as AgentManager,
      cwd: "/tmp/repo",
      firstAgentContext: { prompt: "Add a payments flow with Stripe checkout" },
      logger: createLogger(),
      deps: { generateStructuredAgentResponseWithFallback: structured.generateStructured },
    });

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Add payments flow");
    expect(result?.branch).toBe("pay/checkout");
    // Branch is not a kebab-slug of the title — they are independently generated
    expect(result?.branch).not.toBe("add-payments-flow");
    expect(structured.calls).toHaveLength(1);
  });

  test("calls the structured generator with first-agent prompt text", async () => {
    const structured = createStructuredGenerator({
      title: "Fix login flow",
      branch: "fix-login-flow",
    });

    const result = await generateBranchNameFromFirstAgentContext({
      agentManager: {} as AgentManager,
      cwd: "/tmp/repo",
      firstAgentContext: { prompt: "Fix the login flow" },
      logger: createLogger(),
      deps: { generateStructuredAgentResponseWithFallback: structured.generateStructured },
    });

    expect(result?.branch).toBe("fix-login-flow");
    expect(structured.calls).toHaveLength(1);
    const firstCall = structured.calls[0];
    if (!firstCall) {
      throw new Error("expected structured generation call");
    }
    expect(firstCall).toMatchObject({
      cwd: "/tmp/repo",
      schemaName: "BranchName",
      maxRetries: 2,
      agentConfigOverrides: {
        title: "Branch name generator",
        internal: true,
      },
    });
    expect(firstCall.prompt).toContain("Fix the login flow");
  });

  test("uses attachment-only context", async () => {
    const structured = createStructuredGenerator({
      title: "Review flaky checkout",
      branch: "review-flaky-checkout",
    });

    const result = await generateBranchNameFromFirstAgentContext({
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
      deps: { generateStructuredAgentResponseWithFallback: structured.generateStructured },
    });

    expect(result?.branch).toBe("review-flaky-checkout");
    const firstCall = structured.calls[0];
    if (!firstCall) {
      throw new Error("expected structured generation call");
    }
    expect(firstCall.prompt).toContain("Review flaky checkout");
  });

  test("uses the current selection as the final provider fallback", async () => {
    const structured = createStructuredGenerator({
      title: "Focused task",
      branch: "focused-branch",
    });

    const result = await generateBranchNameFromFirstAgentContext({
      agentManager: {} as AgentManager,
      cwd: "/tmp/repo",
      providerSnapshotManager: {
        listProviders: vi.fn(async () => [
          {
            provider: "focused-provider",
            status: "ready" as const,
            enabled: true,
            models: [
              {
                provider: "focused-provider",
                id: "selected-model",
                label: "Selected Model",
                isDefault: true,
              },
            ],
          },
        ]),
      },
      currentSelection: {
        provider: "focused-provider",
        model: "selected-model",
        thinkingOptionId: "medium",
      },
      firstAgentContext: { prompt: "Fix the login flow" },
      logger: createLogger(),
      deps: { generateStructuredAgentResponseWithFallback: structured.generateStructured },
    });

    expect(result?.branch).toBe("focused-branch");
    const firstCall = structured.calls[0];
    if (!firstCall) {
      throw new Error("expected structured generation call");
    }
    expect(firstCall.providers).toEqual([
      { provider: "focused-provider", model: "selected-model", thinkingOptionId: "medium" },
    ]);
  });

  test.each([
    ["paseo.json missing", undefined],
    ["paseo.json exists but invalid JSON", "{ nope"],
    ["paseo.json valid but missing metadataGeneration", {}],
    [
      "metadataGeneration exists but missing branchName",
      { metadataGeneration: { commitMessage: { instructions: "Use Conventional Commits." } } },
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
    [
      "title exists but instructions is empty",
      { metadataGeneration: { title: { instructions: "" } } },
    ],
  ])("renders the default styles when no overrides apply (%s)", async (_name, config) => {
    const { prompt } = await generateBranchPromptWithConfig(config);

    expect(prompt).toBe(BRANCH_PROMPT_BASELINE);
  });

  test("title instructions replace the default title style, leaving the rest intact", async () => {
    const { prompt } = await generateBranchPromptWithConfig({
      metadataGeneration: { title: { instructions: "Title in Spanish." } },
    });

    expect(prompt).toContain("Title style:\nTitle in Spanish.");
    expect(prompt).not.toContain("Aim for about 4 words");
    // Contract and branch style are not part of the title override.
    expect(prompt).toContain("Generate a title and a git branch name");
    expect(prompt).toContain("Branch style:\nA short, descriptive slug");
    expect(prompt).toContain("Return JSON only with fields 'title' and 'branch'.");
  });

  test("branch instructions replace the default branch style, leaving the title style intact", async () => {
    const { prompt } = await generateBranchPromptWithConfig({
      metadataGeneration: { branchName: { instructions: "Use the prefix mb/." } },
    });

    expect(prompt).toContain("Branch style:\nUse the prefix mb/.");
    expect(prompt).not.toContain("A short, descriptive slug");
    expect(prompt).toContain("Aim for about 4 words");
  });

  test("the contract is never overridable by user instructions", async () => {
    const { prompt } = await generateBranchPromptWithConfig({
      metadataGeneration: {
        title: { instructions: "anything" },
        branchName: { instructions: "anything" },
      },
    });

    expect(prompt).toContain(
      "The branch is generated directly from the prompt — it is NEVER derived from or slugified from the title.",
    );
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
    const structured = createStructuredGenerator({
      title: "Invalid title",
      branch: "Invalid Branch Name",
    });
    const renameCurrentBranch = vi.fn(async () => ({
      previousBranch: "dazzling-yak",
      currentBranch: "Invalid Branch Name",
    }));

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
          deps: { generateStructuredAgentResponseWithFallback: structured.generateStructured },
        }).then((r) => r?.branch ?? null),
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

  const structured = createStructuredGenerator({
    title: "Fix login flow",
    branch: "fix-login-flow",
  });

  await generateBranchNameFromFirstAgentContext({
    agentManager: {} as AgentManager,
    cwd: path.join(repoRoot, "nested"),
    workspaceGitService: createNoopWorkspaceGitService({
      resolveRepoRoot: async () => repoRoot,
    }),
    firstAgentContext: { prompt: "Fix the login flow" },
    logger: createLogger(),
    deps: { generateStructuredAgentResponseWithFallback: structured.generateStructured },
  });

  return {
    prompt: String(structured.calls[0]?.prompt),
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
