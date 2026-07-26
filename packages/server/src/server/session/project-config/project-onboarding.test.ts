import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  StructuredTextGeneration,
  StructuredTextGenerationRequest,
} from "../checkout/git-metadata-generator.js";
import { generateProjectOnboardingProposal, scanProjectContext } from "./project-onboarding.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeProject(): string {
  const directory = mkdtempSync(join(tmpdir(), "paseo-project-onboarding-"));
  tempDirs.push(directory);
  return directory;
}

describe("project onboarding", () => {
  it("scans bounded project guidance while ignoring dependency directories", async () => {
    const repoRoot = makeProject();
    writeFileSync(join(repoRoot, "README.md"), "# App\nRun with npm run dev.");
    writeFileSync(join(repoRoot, "package.json"), '{"scripts":{"dev":"vite"}}');
    mkdirSync(join(repoRoot, "docs"));
    writeFileSync(join(repoRoot, "docs", "CONTRIBUTING.md"), "Use npm ci.");
    mkdirSync(join(repoRoot, "node_modules"));
    writeFileSync(join(repoRoot, "node_modules", "README.md"), "Ignore me.");

    const files = await scanProjectContext(repoRoot);

    expect(files.map((file) => file.path)).toEqual([
      "package.json",
      "README.md",
      join("docs", "CONTRIBUTING.md"),
    ]);
    expect(files.map((file) => file.content).join("\n")).not.toContain("Ignore me");
  });

  it("returns a reviewable merged proposal without writing paseo.json", async () => {
    const repoRoot = makeProject();
    writeFileSync(join(repoRoot, "README.md"), "# App\nnpm run dev starts Vite on port 5173.");
    const calls: Array<StructuredTextGenerationRequest<unknown>> = [];
    const generation: StructuredTextGeneration = {
      generate: async <T>(request: StructuredTextGenerationRequest<T>): Promise<T> => {
        calls.push(request as StructuredTextGenerationRequest<unknown>);
        return {
          worktree: { setup: ["npm ci"] },
          scripts: [{ name: "web", command: "npm run dev", type: "service", port: 5173 }],
          metadataGeneration: { branchName: "Use feat/ and fix/ prefixes." },
        } as T;
      },
    };

    const result = await generateProjectOnboardingProposal({
      repoRoot,
      existingConfig: {
        customField: "preserved",
        worktree: { teardown: "npm run clean" },
      },
      generation,
    });

    expect(result).toEqual({
      config: {
        customField: "preserved",
        worktree: {
          setup: ["npm ci"],
          teardown: "npm run clean",
        },
        scripts: {
          web: {
            command: "npm run dev",
            type: "service",
            port: 5173,
          },
        },
        metadataGeneration: {
          branchName: { instructions: "Use feat/ and fix/ prefixes." },
        },
      },
      scannedFiles: ["README.md"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      cwd: repoRoot,
      schemaName: "PaseoProjectOnboarding",
      agentTitle: "Project onboarding",
    });
    expect(calls[0]?.prompt).toContain("--- README.md ---");
    expect(calls[0]?.prompt).toContain("npm run dev starts Vite");
    expect(existsSync(join(repoRoot, "paseo.json"))).toBe(false);
  });
});
