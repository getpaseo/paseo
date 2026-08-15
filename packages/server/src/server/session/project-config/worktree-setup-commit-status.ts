import {
  PaseoConfigRawSchema,
  isPaseoPlatformCommand,
  normalizeLifecycleCommands,
  selectPaseoPlatformCommand,
  type PaseoConfigRaw,
} from "@getpaseo/protocol/paseo-config-schema";
import { READ_ONLY_GIT_ENV } from "../../checkout-git-utils.js";
import { runGitCommand } from "../../../utils/run-git-command.js";

export async function hasUncommittedWorktreeSetupChanges(input: {
  repoRoot: string;
  currentConfig: PaseoConfigRaw | null;
}): Promise<boolean> {
  const gitPath = await resolveConfigGitPath(input.repoRoot);
  const committedConfig = await readCommittedConfig(input.repoRoot, gitPath);
  const currentSetup = normalizeCurrentPlatformSetup(input.currentConfig?.worktree?.setup);
  const committedSetup = normalizeCurrentPlatformSetup(committedConfig?.worktree?.setup);
  return !stringArraysEqual(currentSetup, committedSetup);
}

function normalizeCurrentPlatformSetup(value: unknown): string[] {
  const selected = isPaseoPlatformCommand(value)
    ? selectPaseoPlatformCommand(value, process.platform)
    : value;
  return normalizeLifecycleCommands(selected);
}

async function resolveConfigGitPath(repoRoot: string): Promise<string> {
  const { stdout } = await runGitCommand(["rev-parse", "--show-prefix"], {
    cwd: repoRoot,
    envOverlay: READ_ONLY_GIT_ENV,
  });
  return `${stdout.trim()}paseo.json`;
}

async function readCommittedConfig(
  repoRoot: string,
  gitPath: string,
): Promise<PaseoConfigRaw | null> {
  await runGitCommand(["rev-parse", "--verify", "HEAD"], {
    cwd: repoRoot,
    envOverlay: READ_ONLY_GIT_ENV,
  });
  const { stdout: trackedPath } = await runGitCommand(
    ["ls-tree", "--name-only", "HEAD", "--", gitPath],
    {
      cwd: repoRoot,
      envOverlay: READ_ONLY_GIT_ENV,
    },
  );
  if (trackedPath.trim().length === 0) return null;

  const { stdout } = await runGitCommand(["show", `HEAD:${gitPath}`], {
    cwd: repoRoot,
    envOverlay: READ_ONLY_GIT_ENV,
  });
  return PaseoConfigRawSchema.parse(JSON.parse(stdout));
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
