import { describe, expect, test, vi } from "vitest";

import type { AgentManager } from "./agent/agent-manager.js";
import { generateBranchNameFromFirstAgentContext } from "./worktree-branch-name-generator.js";

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
});
