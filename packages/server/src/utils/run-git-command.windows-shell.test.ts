import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runGitCommand } from "./run-git-command.js";

const tempDirs: string[] = [];

function makeTempRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "paseo-git-shell-"));
  tempDirs.push(repo);
  return repo;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("runGitCommand shell behavior", () => {
  it("passes git arguments directly instead of through the platform shell", async () => {
    const repo = makeTempRepo();
    const literalName = "%PASEO_GIT_SHELL_SENTINEL%";
    const expandedName = "expanded-by-cmd";

    await runGitCommand(["init"], { cwd: repo });
    writeFileSync(path.join(repo, literalName), "literal\n");
    writeFileSync(path.join(repo, expandedName), "expanded\n");
    await runGitCommand(["add", literalName, expandedName], { cwd: repo });

    const result = await runGitCommand(["ls-files", "--error-unmatch", literalName], {
      cwd: repo,
      envOverlay: {
        PASEO_GIT_SHELL_SENTINEL: expandedName,
      },
    });

    expect(result.stdout.trim()).toBe(literalName);
  });
});
