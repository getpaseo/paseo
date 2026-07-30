import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMetadataPrompt, type RepoRootResolver } from "./build-metadata-prompt.js";

describe("buildMetadataPrompt", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "build-metadata-prompt-test-")));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const CONTRACT = "Produce the artifact.";
  const DEFAULT_STYLE = "Default style guidance.";
  const OVERRIDE_STYLE = "Custom override style from paseo.json.";
  const REPO_ROOT_OVERRIDE = "Repo-root override style from paseo.json.";

  function buildOptions(cwd: string, workspaceGitService?: RepoRootResolver) {
    return {
      cwd,
      contract: CONTRACT,
      styles: [{ configKey: "title" as const, default: DEFAULT_STYLE }],
      after: "Seed prompt.",
      workspaceGitService,
    };
  }

  function writeTitleOverride(dir: string, instructions: string) {
    writeFileSync(
      join(dir, "paseo.json"),
      JSON.stringify({ metadataGeneration: { title: { instructions } } }),
    );
  }

  it("reads paseo.json overrides from the resolved git repo root", async () => {
    // cwd has no paseo.json; the override lives only at the resolved repo root.
    const repoRoot = join(tempDir, "repo");
    mkdirSync(repoRoot);
    writeTitleOverride(repoRoot, REPO_ROOT_OVERRIDE);
    const resolver: RepoRootResolver = { resolveRepoRoot: async () => repoRoot };

    const prompt = await buildMetadataPrompt(buildOptions(tempDir, resolver));

    expect(prompt).toContain(REPO_ROOT_OVERRIDE);
    expect(prompt).not.toContain(DEFAULT_STYLE);
  });

  it("falls back to cwd when resolveRepoRoot throws in a non-git directory", async () => {
    writeTitleOverride(tempDir, OVERRIDE_STYLE);
    const resolver: RepoRootResolver = {
      resolveRepoRoot: async () => {
        throw new Error("Create worktree requires a git repository");
      },
    };

    const prompt = await buildMetadataPrompt(buildOptions(tempDir, resolver));

    expect(prompt).toContain(OVERRIDE_STYLE);
    expect(prompt).not.toContain(DEFAULT_STYLE);
  });

  it("reads overrides from cwd when no workspace git service is provided", async () => {
    writeTitleOverride(tempDir, OVERRIDE_STYLE);

    const prompt = await buildMetadataPrompt(buildOptions(tempDir));

    expect(prompt).toContain(OVERRIDE_STYLE);
    expect(prompt).not.toContain(DEFAULT_STYLE);
  });

  it("uses the default style when no paseo.json exists in the fallback dir", async () => {
    const resolver: RepoRootResolver = {
      resolveRepoRoot: async () => {
        throw new Error("Create worktree requires a git repository");
      },
    };

    const prompt = await buildMetadataPrompt(buildOptions(tempDir, resolver));

    expect(prompt).toContain(DEFAULT_STYLE);
  });

  it("uses the default style when paseo.json is invalid JSON", async () => {
    writeFileSync(join(tempDir, "paseo.json"), "{ invalid json\n");
    const resolver: RepoRootResolver = {
      resolveRepoRoot: async () => {
        throw new Error("Create worktree requires a git repository");
      },
    };

    const prompt = await buildMetadataPrompt(buildOptions(tempDir, resolver));

    expect(prompt).toContain(DEFAULT_STYLE);
  });
});
