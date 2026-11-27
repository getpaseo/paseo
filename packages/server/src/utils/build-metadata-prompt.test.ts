import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  buildMetadataPrompt,
  type BuildMetadataPromptOptions,
  type MetadataStyleSection,
} from "./build-metadata-prompt.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const cleanupPath of cleanupPaths.splice(0)) {
    rmSync(cleanupPath, { recursive: true, force: true });
  }
});

const STYLES: MetadataStyleSection[] = [
  { configKey: "title", label: "Title style", default: "DEFAULT TITLE" },
  { configKey: "branchName", label: "Branch style", default: "DEFAULT BRANCH" },
  { configKey: "commitMessage", default: "DEFAULT COMMIT" },
];

function createRepo(config?: unknown, options: { git?: boolean } = {}): string {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "paseo-metadata-prompt-"));
  cleanupPaths.push(repoRoot);
  if (options.git !== false) {
    mkdirSync(path.join(repoRoot, ".git"));
  }
  if (config !== undefined) {
    writeFileSync(path.join(repoRoot, "paseo.json"), `${JSON.stringify(config)}\n`);
  }
  return repoRoot;
}

async function build(
  options: {
    repoRoot?: string;
    globalInstructions?: BuildMetadataPromptOptions["globalInstructions"];
  } = {},
): Promise<string> {
  return buildMetadataPrompt({
    cwd: options.repoRoot ?? "/tmp/paseo-metadata-prompt-no-repo",
    workspaceGitService: options.repoRoot
      ? { resolveRepoRoot: async () => options.repoRoot as string }
      : undefined,
    contract: "CONTRACT",
    styles: STYLES,
    after: "AFTER",
    globalInstructions: options.globalInstructions,
  });
}

describe("buildMetadataPrompt instruction precedence", () => {
  test("uses the built-in styles when neither host nor project configures instructions", async () => {
    expect(await build()).toBe(
      [
        "CONTRACT",
        "Title style:\nDEFAULT TITLE",
        "Branch style:\nDEFAULT BRANCH",
        "DEFAULT COMMIT",
        "AFTER",
      ].join("\n\n"),
    );
  });

  test("a non-git workspace falls back to the host-wide instructions", async () => {
    // resolveRepoRoot throws for directories that are not git repositories, so the
    // project override never loads. The host-level wording is the only knob there.
    const prompt = await build({
      globalInstructions: { title: { instructions: "Titles in Simplified Chinese." } },
    });

    expect(prompt).toContain("Title style:\nTitles in Simplified Chinese.");
    expect(prompt).not.toContain("DEFAULT TITLE");
    expect(prompt).toContain("Branch style:\nDEFAULT BRANCH");
  });

  test("host instructions apply when the project has no paseo.json", async () => {
    const repoRoot = createRepo();

    expect(
      await build({
        repoRoot,
        globalInstructions: { commitMessage: { instructions: "Conventional Commits." } },
      }),
    ).toContain("Conventional Commits.");
  });

  test("project instructions win over host instructions for the same type", async () => {
    const repoRoot = createRepo({
      metadataGeneration: { title: { instructions: "PROJECT TITLE" } },
    });

    const prompt = await build({
      repoRoot,
      globalInstructions: { title: { instructions: "HOST TITLE" } },
    });

    expect(prompt).toContain("Title style:\nPROJECT TITLE");
    expect(prompt).not.toContain("HOST TITLE");
  });

  test("each metadata type resolves independently", async () => {
    const repoRoot = createRepo({
      metadataGeneration: { branchName: { instructions: "PROJECT BRANCH" } },
    });

    const prompt = await build({
      repoRoot,
      globalInstructions: {
        title: { instructions: "HOST TITLE" },
        branchName: { instructions: "HOST BRANCH" },
      },
    });

    expect(prompt).toContain("Title style:\nHOST TITLE");
    expect(prompt).toContain("Branch style:\nPROJECT BRANCH");
    expect(prompt).not.toContain("HOST BRANCH");
  });

  test.each([
    ["empty", ""],
    ["whitespace-only", "   \n\t "],
  ])("ignores %s host instructions", async (_name, instructions) => {
    expect(await build({ globalInstructions: { title: { instructions } } })).toContain(
      "Title style:\nDEFAULT TITLE",
    );
  });

  test("empty project instructions fall through to the host instructions", async () => {
    const repoRoot = createRepo({ metadataGeneration: { title: { instructions: "  " } } });

    expect(
      await build({
        repoRoot,
        globalInstructions: { title: { instructions: "HOST TITLE" } },
      }),
    ).toContain("Title style:\nHOST TITLE");
  });

  test("an invalid paseo.json falls back to the host instructions", async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "paseo-metadata-prompt-"));
    cleanupPaths.push(repoRoot);
    writeFileSync(path.join(repoRoot, "paseo.json"), "{ nope");

    expect(
      await build({
        repoRoot,
        globalInstructions: { title: { instructions: "HOST TITLE" } },
      }),
    ).toContain("Title style:\nHOST TITLE");
  });
});
