import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { buildMetadataPrompt } from "./build-metadata-prompt.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("buildMetadataPrompt", () => {
  test("uses per-project agent summary instructions", async () => {
    const repoRoot = mkdtempSync(path.join(os.tmpdir(), "paseo-agent-summary-prompt-"));
    tempDirs.push(repoRoot);
    writeFileSync(
      path.join(repoRoot, "paseo.json"),
      JSON.stringify({
        metadataGeneration: {
          agentSummary: {
            instructions: "Name the concrete outcome and current phase.",
          },
        },
      }),
    );

    const prompt = await buildMetadataPrompt({
      cwd: repoRoot,
      contract: "Return JSON with a summary field.",
      styles: [
        {
          configKey: "agentSummary",
          default: "Summarize the agent's purpose.",
          label: "Summary style",
        },
      ],
      after: "Use only the supplied transcript.",
      workspaceGitService: {
        resolveRepoRoot: async () => repoRoot,
      },
    });

    expect(prompt).toContain("Summary style:\nName the concrete outcome and current phase.");
    expect(prompt).not.toContain("Summarize the agent's purpose.");
    expect(prompt).toContain("Return JSON with a summary field.");
    expect(prompt).toContain("Use only the supplied transcript.");
  });
});
