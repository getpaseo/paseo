import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentManager } from "../../agent/agent-manager.js";
import {
  generateStructuredAgentResponseWithFallback,
  StructuredAgentFallbackError,
  StructuredAgentResponseError,
} from "../../agent/agent-response-loop.js";
import type { CheckoutDiffCompare, CheckoutDiffResult } from "../../../utils/checkout-git.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";
import {
  createAgentStructuredTextGeneration,
  createGitMetadataGenerator,
  type StructuredTextGeneration,
  type StructuredTextGenerationRequest,
} from "./git-metadata-generator.js";

vi.mock("../../agent/agent-response-loop.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agent/agent-response-loop.js")>()),
  generateStructuredAgentResponseWithFallback: vi.fn().mockResolvedValue({}),
}));

type DiffSource = Pick<WorkspaceGitService, "getCheckoutDiff" | "resolveRepoRoot">;

function createDiffSource(result: CheckoutDiffResult) {
  const diffCalls: Array<{ cwd: string; options: CheckoutDiffCompare }> = [];
  const diffSource: DiffSource = {
    getCheckoutDiff: async (cwd, options) => {
      diffCalls.push({ cwd, options });
      return result;
    },
    // buildMetadataPrompt reads paseo.json overrides from here; an unknown root
    // means no override applies, so the default style is used.
    resolveRepoRoot: async () => "/tmp/git-metadata-generator-test-missing-root",
  };
  return { diffSource, diffCalls };
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
    const { diffSource, diffCalls } = createDiffSource(DIFF_WITH_ONE_FILE);
    const { generation, generateCalls } = createGeneration(() => ({
      message: "Fix the flaky retry test",
    }));
    const generator = createGitMetadataGenerator({ workspaceGitService: diffSource, generation });

    const message = await generator.generateCommitMessage("/repo");

    expect(message).toBe("Fix the flaky retry test");
    expect(diffCalls).toEqual([
      { cwd: "/repo", options: { mode: "uncommitted", includeStructured: true } },
    ]);
    expect(generateCalls[0]).toMatchObject({
      cwd: "/repo",
      purpose: "commit",
      schemaName: "CommitMessage",
      agentTitle: "Commit generator",
    });
    expect(generateCalls[0].prompt).toContain("Write a concise git commit message");
    expect(generateCalls[0].prompt).toContain("M\tsrc/foo.ts\t(+3 -1)");
    expect(generateCalls[0].prompt).toContain("diff --git a/src/foo.ts");
  });

  it("generateCommitMessage falls back to a default message when generation exhausts its providers", async () => {
    const { diffSource } = createDiffSource(DIFF_WITH_ONE_FILE);
    const { generation } = createGeneration(() => {
      throw new StructuredAgentFallbackError([]);
    });
    const generator = createGitMetadataGenerator({ workspaceGitService: diffSource, generation });

    await expect(generator.generateCommitMessage("/repo")).resolves.toBe("Update files");
  });

  it("generateCommitMessage falls back when the generated response cannot be validated", async () => {
    const { diffSource } = createDiffSource(DIFF_WITH_ONE_FILE);
    const { generation } = createGeneration(() => {
      throw new StructuredAgentResponseError("invalid", {
        lastResponse: "{}",
        validationErrors: ["message: required"],
      });
    });
    const generator = createGitMetadataGenerator({ workspaceGitService: diffSource, generation });

    await expect(generator.generateCommitMessage("/repo")).resolves.toBe("Update files");
  });

  it("generateCommitMessage rethrows errors that are not structured-generation failures", async () => {
    const { diffSource } = createDiffSource(DIFF_WITH_ONE_FILE);
    const { generation } = createGeneration(() => {
      throw new Error("network down");
    });
    const generator = createGitMetadataGenerator({ workspaceGitService: diffSource, generation });

    await expect(generator.generateCommitMessage("/repo")).rejects.toThrow("network down");
  });

  it("generatePullRequestText returns the generated title and body from a base-diff prompt", async () => {
    const { diffSource, diffCalls } = createDiffSource(DIFF_WITH_ONE_FILE);
    const { generation, generateCalls } = createGeneration(() => ({
      title: "Add retry with backoff",
      body: "Retries transient failures up to twice.",
    }));
    const generator = createGitMetadataGenerator({ workspaceGitService: diffSource, generation });

    const result = await generator.generatePullRequestText("/repo", "main");

    expect(result).toEqual({
      title: "Add retry with backoff",
      body: "Retries transient failures up to twice.",
    });
    expect(diffCalls).toEqual([
      { cwd: "/repo", options: { mode: "base", baseRef: "main", includeStructured: true } },
    ]);
    expect(generateCalls[0]).toMatchObject({
      cwd: "/repo",
      purpose: "pull-request",
      schemaName: "PullRequest",
      agentTitle: "PR generator",
    });
    expect(generateCalls[0].prompt).toContain("Write a pull request title and body");
  });

  it("generatePullRequestText falls back to default PR text when generation fails", async () => {
    const { diffSource } = createDiffSource(DIFF_WITH_ONE_FILE);
    const { generation } = createGeneration(() => {
      throw new StructuredAgentFallbackError([]);
    });
    const generator = createGitMetadataGenerator({ workspaceGitService: diffSource, generation });

    await expect(generator.generatePullRequestText("/repo")).resolves.toEqual({
      title: "Update changes",
      body: "Automated PR generated by Paseo.",
    });
  });
});

describe("createAgentStructuredTextGeneration model selection", () => {
  it("uses each manual selection exclusively and reads changes on the next request", async () => {
    const automatic = { provider: "codex", model: "automatic-model" };
    const commit = { provider: "codex", model: "commit-model", thinkingOptionId: "low" };
    const pr = { provider: "claude", model: "pr-model" };
    let config = {
      metadataGeneration: { providers: [automatic] },
      workspaceGitWorkflow: { commitModel: commit, prModel: pr },
    };
    const listProviders = vi.fn().mockResolvedValue([]);
    const generation = createAgentStructuredTextGeneration({
      agentManager: {} as AgentManager,
      providerSnapshotManager: { listProviders },
      readDaemonConfig: () => config,
      getFocusedSelection: () => undefined,
    });
    const request = {
      cwd: "/repo",
      prompt: "Generate",
      schema: z.object({}),
      schemaName: "Test",
      agentTitle: "Test",
    };
    const generate = vi.mocked(generateStructuredAgentResponseWithFallback);
    await generation.generate({ ...request, purpose: "commit" });
    expect(generate.mock.lastCall?.[0].providers).toEqual([commit]);
    await generation.generate({ ...request, purpose: "pull-request" });
    expect(generate.mock.lastCall?.[0].providers).toEqual([pr]);
    expect(listProviders).not.toHaveBeenCalled();
    config = {
      ...config,
      workspaceGitWorkflow: {
        ...config.workspaceGitWorkflow,
        commitModel: { ...commit, model: "updated-commit-model" },
      },
    };
    await generation.generate({ ...request, purpose: "commit" });
    expect(generate.mock.lastCall?.[0].providers).toEqual([
      config.workspaceGitWorkflow.commitModel,
    ]);
  });

  it.each([undefined, null])(
    "keeps automatic resolution when manual selection is %s",
    async (selection) => {
      const automatic = { provider: "codex", model: "automatic-model" };
      const generation = createAgentStructuredTextGeneration({
        agentManager: {} as AgentManager,
        providerSnapshotManager: { listProviders: vi.fn().mockResolvedValue([]) },
        readDaemonConfig: () => ({
          metadataGeneration: { providers: [automatic] },
          workspaceGitWorkflow: { commitModel: selection, prModel: selection },
        }),
        getFocusedSelection: () => undefined,
      });
      for (const purpose of ["commit", "pull-request"] as const) {
        await generation.generate({
          cwd: "/repo",
          prompt: "Generate",
          schema: z.object({}),
          schemaName: "Test",
          agentTitle: "Test",
          purpose,
        });
        expect(
          vi.mocked(generateStructuredAgentResponseWithFallback).mock.lastCall?.[0].providers,
        ).toEqual([automatic]);
      }
    },
  );
});
