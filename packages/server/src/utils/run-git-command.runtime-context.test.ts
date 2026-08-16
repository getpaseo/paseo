import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureGitProcessPolicy,
  type GitCommandResult,
  runGitCommand,
  runWithGitCommandRunner,
} from "./run-git-command.js";
import { resolveGitProcessPolicy } from "./git-process-scheduler.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

async function createRepository(branch: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-git-runtime-context-"));
  directories.push(directory);
  await execFileAsync("git", ["init", "--initial-branch", branch], { cwd: directory });
  return directory;
}

function createRuntimeRunner(
  runtimeCwd: string,
  waitBeforeReturning?: Promise<void>,
): (args: string[]) => Promise<GitCommandResult> {
  return async (args) => {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd: runtimeCwd });
    await waitBeforeReturning;
    return {
      stdout,
      stderr,
      truncated: false,
      exitCode: 0,
      signal: null,
    };
  };
}

afterEach(async () => {
  configureGitProcessPolicy(resolveGitProcessPolicy({ env: process.env }));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("runGitCommand runtime submission context", () => {
  it("keeps queued commands in the selected runtime that submitted them", async () => {
    configureGitProcessPolicy({ maxProcessConcurrency: 1, maxProcessesPerSecond: 1_000 });
    const [runtimeA, runtimeB, hostDecoyA, hostDecoyB] = await Promise.all([
      createRepository("runtime-a"),
      createRepository("runtime-b"),
      createRepository("host-decoy-a"),
      createRepository("host-decoy-b"),
    ]);
    let releaseRuntimeA!: () => void;
    const runtimeAHold = new Promise<void>((resolve) => {
      releaseRuntimeA = resolve;
    });

    const first = runWithGitCommandRunner(createRuntimeRunner(runtimeA, runtimeAHold), () =>
      runGitCommand(["branch", "--show-current"], { cwd: hostDecoyA }),
    );
    const second = runWithGitCommandRunner(createRuntimeRunner(runtimeB), () =>
      runGitCommand(["branch", "--show-current"], { cwd: hostDecoyB }),
    );

    releaseRuntimeA();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ stdout: "runtime-a\n" }),
      expect.objectContaining({ stdout: "runtime-b\n" }),
    ]);
  });
});
