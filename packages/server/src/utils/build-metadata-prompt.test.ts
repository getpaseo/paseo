import { describe, expect, it, vi } from "vitest";
import { buildMetadataPrompt, loadCommittedMetadataGeneration } from "./build-metadata-prompt.js";

describe("buildMetadataPrompt", () => {
  it("renders all committed metadata style overrides without changing the contract", () => {
    const prompt = buildMetadataPrompt({
      contract: "Return the requested metadata.",
      styles: [
        { configKey: "title", label: "Title", default: "Default title" },
        { configKey: "branchName", label: "Branch", default: "Default branch" },
        { configKey: "commitMessage", label: "Commit", default: "Default commit" },
        { configKey: "pullRequest", label: "Pull request", default: "Default pull request" },
      ],
      after: "Return JSON only.",
      metadataGeneration: {
        title: { instructions: "Task-shaped title" },
        branchName: { instructions: "Prefix branches with fix/" },
        commitMessage: { instructions: "Use Conventional Commits" },
        pullRequest: { instructions: "Include a testing section" },
      },
    });

    expect(prompt).toBe(`Return the requested metadata.

Title:
Task-shaped title

Branch:
Prefix branches with fix/

Commit:
Use Conventional Commits

Pull request:
Include a testing section

Return JSON only.`);
  });

  it("uses the default style for missing or empty instructions", () => {
    const prompt = buildMetadataPrompt({
      contract: "Contract",
      styles: [
        { configKey: "title", default: "Default title" },
        { configKey: "branchName", default: "Default branch" },
      ],
      after: "After",
      metadataGeneration: {
        title: { instructions: "  " },
      },
    });

    expect(prompt).toBe("Contract\n\nDefault title\n\nDefault branch\n\nAfter");
  });
});

describe("loadCommittedMetadataGeneration", () => {
  it("reads the repository-root committed configuration with a one MiB limit", async () => {
    const readHeadFile = vi.fn(async () =>
      JSON.stringify({ metadataGeneration: { commitMessage: { instructions: "Use a scope" } } }),
    );

    await expect(loadCommittedMetadataGeneration({ readHeadFile })).resolves.toEqual({
      commitMessage: { instructions: "Use a scope" },
    });
    expect(readHeadFile).toHaveBeenCalledWith("paseo.json", { maxBytes: 1024 * 1024 });
  });

  it("returns no overrides when the committed configuration is absent", async () => {
    const readHeadFile = vi.fn(async () => null);

    await expect(loadCommittedMetadataGeneration({ readHeadFile })).resolves.toBeUndefined();
  });

  it("rejects malformed JSON without including repository content in the error", async () => {
    const readHeadFile = vi.fn(async () => '{ "private": "do-not-log"');

    const error = await loadCommittedMetadataGeneration({ readHeadFile }).catch(
      (cause: unknown) => cause,
    );

    expect(error).toEqual(new Error("Committed paseo.json contains invalid JSON"));
    expect(String(error)).not.toContain("do-not-log");
  });

  it("rejects configuration that fails the full raw schema", async () => {
    const readHeadFile = vi.fn(async () =>
      JSON.stringify({ worktree: { servicePorts: { range: "5000-4000" } } }),
    );

    await expect(loadCommittedMetadataGeneration({ readHeadFile })).rejects.toThrow(
      "Committed paseo.json does not match the Paseo configuration schema",
    );
  });

  it.each([
    ["metadataGeneration", { metadataGeneration: "not an object" }],
    ["metadata entry", { metadataGeneration: { commitMessage: "not an object" } }],
    ["metadata instructions", { metadataGeneration: { commitMessage: { instructions: 42 } } }],
  ])("rejects an invalid %s instead of applying compatibility defaults", async (_name, config) => {
    const readHeadFile = vi.fn(async () => JSON.stringify(config));

    await expect(loadCommittedMetadataGeneration({ readHeadFile })).rejects.toThrow(
      "Committed paseo.json does not match the Paseo configuration schema",
    );
  });

  it("propagates repository read failures", async () => {
    const readHeadFile = vi.fn(async () => {
      throw new Error("runtime unavailable");
    });

    await expect(loadCommittedMetadataGeneration({ readHeadFile })).rejects.toThrow(
      "runtime unavailable",
    );
  });
});
