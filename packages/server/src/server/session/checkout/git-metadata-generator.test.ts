import { describe, expect, it, vi } from "vitest";
import {
  StructuredAgentFallbackError,
  StructuredAgentResponseError,
} from "../../agent/agent-response-loop.js";
import type { CheckoutDiffCompare, CheckoutDiffResult } from "../../../utils/checkout-git.js";
import type { WorkspaceGitWorkspace } from "../../workspace-git-service.js";
import {
  createGitMetadataGenerator,
  type StructuredTextGeneration,
  type StructuredTextGenerationRequest,
} from "./git-metadata-generator.js";

function createWorkspaceGit(result: CheckoutDiffResult, paseoConfig: string | null = null) {
  const diffCalls: Array<{ cwd: string; options: CheckoutDiffCompare }> = [];
  const readHeadFile = vi.fn(async () => paseoConfig);
  const workspaceGit: Pick<WorkspaceGitWorkspace, "cwd" | "getCheckoutDiff" | "readHeadFile"> = {
    cwd: "/repo",
    getCheckoutDiff: async (options) => {
      diffCalls.push({ cwd: "/repo", options });
      return result;
    },
    readHeadFile,
  };
  return { diffCalls, readHeadFile, workspaceGit };
}

function createGeneration(handler: (request: StructuredTextGenerationRequest<unknown>) => unknown) {
  const generateCalls: Array<StructuredTextGenerationRequest<unknown>> = [];
  const generation: StructuredTextGeneration = {
    generate: async <T>(request: StructuredTextGenerationRequest<T>): Promise<T> => {
      generateCalls.push(request as StructuredTextGenerationRequest<unknown>);
      return handler(request as StructuredTextGenerationRequest<unknown>) as T;
    },
  };
  return { generation, generateCalls };
}

const DIFF_WITH_ONE_FILE: CheckoutDiffResult = {
  diff: "diff --git a/src/foo.ts b/src/foo.ts\n+added\n",
  structured: [
    {
      path: "src/foo.ts",
      isNew: false,
      isDeleted: false,
      additions: 3,
      deletions: 1,
      hunks: [],
      status: "ok",
    },
  ],
};

describe("createGitMetadataGenerator", () => {
  it("generateCommitMessage returns the generated message from an uncommitted-diff prompt", async () => {
    const { diffCalls, readHeadFile, workspaceGit } = createWorkspaceGit(DIFF_WITH_ONE_FILE);
    const { generation, generateCalls } = createGeneration(() => ({
      message: "Fix the flaky retry test",
    }));
    const generator = createGitMetadataGenerator({ generation });

    const message = await generator.generateCommitMessage({
      workspaceGit,
      workspaceId: "workspace-1",
    });

    expect(message).toBe("Fix the flaky retry test");
    expect(diffCalls).toEqual([
      { cwd: "/repo", options: { mode: "uncommitted", includeStructured: true } },
    ]);
    expect(readHeadFile).toHaveBeenCalledWith("paseo.json", { maxBytes: 1024 * 1024 });
    expect(generateCalls[0]).toMatchObject({
      cwd: "/repo",
      workspaceId: "workspace-1",
      schemaName: "CommitMessage",
      agentTitle: "Commit generator",
    });
    expect(generateCalls[0].prompt).toContain("Write a concise git commit message");
    expect(generateCalls[0].prompt).toContain("M\tsrc/foo.ts\t(+3 -1)");
    expect(generateCalls[0].prompt).toContain("diff --git a/src/foo.ts");
  });

  it("uses committed paseo.json instructions in the commit prompt", async () => {
    const { workspaceGit } = createWorkspaceGit(
      DIFF_WITH_ONE_FILE,
      JSON.stringify({
        metadataGeneration: {
          commitMessage: { instructions: "Use Conventional Commits with a package scope." },
        },
      }),
    );
    const { generation, generateCalls } = createGeneration(() => ({ message: "fix(core): retry" }));
    const generator = createGitMetadataGenerator({ generation });

    await generator.generateCommitMessage({ workspaceGit });

    expect(generateCalls[0].prompt).toContain("Use Conventional Commits with a package scope.");
    expect(generateCalls[0].prompt).not.toContain("Concise, imperative mood, no trailing period.");
  });

  it("does not run generation or read the diff when committed paseo.json is invalid", async () => {
    const { diffCalls, workspaceGit } = createWorkspaceGit(DIFF_WITH_ONE_FILE, "{ invalid");
    const { generation, generateCalls } = createGeneration(() => ({ message: "Update files" }));
    const generator = createGitMetadataGenerator({ generation });

    await expect(generator.generateCommitMessage({ workspaceGit })).rejects.toThrow(
      "Committed paseo.json contains invalid JSON",
    );
    expect(diffCalls).toEqual([]);
    expect(generateCalls).toEqual([]);
  });

  it("generateCommitMessage falls back to a default message when generation exhausts its providers", async () => {
    const { workspaceGit } = createWorkspaceGit(DIFF_WITH_ONE_FILE);
    const { generation } = createGeneration(() => {
      throw new StructuredAgentFallbackError([]);
    });
    const generator = createGitMetadataGenerator({ generation });

    await expect(generator.generateCommitMessage({ workspaceGit })).resolves.toBe("Update files");
  });

  it("generateCommitMessage falls back when the generated response cannot be validated", async () => {
    const { workspaceGit } = createWorkspaceGit(DIFF_WITH_ONE_FILE);
    const { generation } = createGeneration(() => {
      throw new StructuredAgentResponseError("invalid", {
        lastResponse: "{}",
        validationErrors: ["message: required"],
      });
    });
    const generator = createGitMetadataGenerator({ generation });

    await expect(generator.generateCommitMessage({ workspaceGit })).resolves.toBe("Update files");
  });

  it("generateCommitMessage rethrows errors that are not structured-generation failures", async () => {
    const { workspaceGit } = createWorkspaceGit(DIFF_WITH_ONE_FILE);
    const { generation } = createGeneration(() => {
      throw new Error("network down");
    });
    const generator = createGitMetadataGenerator({ generation });

    await expect(generator.generateCommitMessage({ workspaceGit })).rejects.toThrow("network down");
  });

  it("generatePullRequestText returns the generated title and body from a base-diff prompt", async () => {
    const { diffCalls, workspaceGit } = createWorkspaceGit(DIFF_WITH_ONE_FILE);
    const { generation, generateCalls } = createGeneration(() => ({
      title: "Add retry with backoff",
      body: "Retries transient failures up to twice.",
    }));
    const generator = createGitMetadataGenerator({ generation });

    const result = await generator.generatePullRequestText({ workspaceGit, baseRef: "main" });

    expect(result).toEqual({
      title: "Add retry with backoff",
      body: "Retries transient failures up to twice.",
    });
    expect(diffCalls).toEqual([
      { cwd: "/repo", options: { mode: "base", baseRef: "main", includeStructured: true } },
    ]);
    expect(generateCalls[0]).toMatchObject({
      cwd: "/repo",
      schemaName: "PullRequest",
      agentTitle: "PR generator",
    });
    expect(generateCalls[0].prompt).toContain("Write a pull request title and body");
  });

  it("uses committed paseo.json instructions in the pull-request prompt", async () => {
    const { workspaceGit } = createWorkspaceGit(
      DIFF_WITH_ONE_FILE,
      JSON.stringify({
        metadataGeneration: {
          pullRequest: { instructions: "Write a terse title and a release-note body." },
        },
      }),
    );
    const { generation, generateCalls } = createGeneration(() => ({
      title: "Retry transient failures",
      body: "Adds bounded retry behavior.",
    }));
    const generator = createGitMetadataGenerator({ generation });

    await generator.generatePullRequestText({ workspaceGit });

    expect(generateCalls[0].prompt).toContain("Write a terse title and a release-note body.");
    expect(generateCalls[0].prompt).not.toContain(
      "Clear, descriptive title; body explaining what changed and why.",
    );
  });

  it("generatePullRequestText falls back to default PR text when generation fails", async () => {
    const { workspaceGit } = createWorkspaceGit(DIFF_WITH_ONE_FILE);
    const { generation } = createGeneration(() => {
      throw new StructuredAgentFallbackError([]);
    });
    const generator = createGitMetadataGenerator({ generation });

    await expect(generator.generatePullRequestText({ workspaceGit })).resolves.toEqual({
      title: "Update changes",
      body: "Automated PR generated by Paseo.",
    });
  });
});
