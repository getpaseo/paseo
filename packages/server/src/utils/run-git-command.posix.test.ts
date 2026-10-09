import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runGitCommand } from "./run-git-command.js";

const tempDirs: string[] = [];

function makeTempRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "paseo-git-fsmonitor-"));
  tempDirs.push(repo);
  return repo;
}

async function configureFsmonitor(repo: string): Promise<string> {
  const hookPath = path.join(repo, "fsmonitor-hook.sh");
  const markerPath = `${hookPath}.marker`;
  writeFileSync(hookPath, "#!/bin/sh\n: > \"$0.marker\"\nprintf '1\\n'\n");
  chmodSync(hookPath, 0o755);
  await runGitCommand(["config", "core.fsmonitor", hookPath], { cwd: repo });
  return markerPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("runGitCommand fsmonitor isolation", () => {
  it("does not execute a repository-configured fsmonitor command", async () => {
    const repo = makeTempRepo();
    await runGitCommand(["init"], { cwd: repo });
    const markerPath = await configureFsmonitor(repo);

    await runGitCommand(["status", "--porcelain"], { cwd: repo });

    expect(existsSync(markerPath)).toBe(false);
  });

  it("overrides core.fsmonitor for commands other than status", async () => {
    const repo = makeTempRepo();
    await runGitCommand(["init"], { cwd: repo });
    await configureFsmonitor(repo);

    const result = await runGitCommand(["config", "--get", "core.fsmonitor"], { cwd: repo });

    expect(result.stdout.trim()).toBe("false");
  });
});
