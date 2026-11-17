import { isAbsolute as isPosixAbsolute } from "node:path/posix";
import { isAbsolute as isWindowsAbsolute } from "node:path/win32";
import { resolve } from "node:path";
import type { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import { resolveCallerAgentId } from "../../utils/caller-agent.js";
import type { DaemonTarget } from "../../utils/daemon-target.js";
import type { CommandError, CommandOptions, SingleResult } from "../../output/index.js";
import { toWorkspaceRow, workspaceSchema, type WorkspaceRow } from "./shared.js";

export interface WorkspaceCreateOptions extends CommandOptions {
  isolation?: string;
  path?: string;
  project?: string;
  title?: string;
  mode?: string;
  worktreeSlug?: string;
  newBranch?: string;
  base?: string;
  branch?: string;
  prNumber?: string;
  forge?: string;
  background?: boolean;
}

interface WorktreeSourceBase {
  kind: "worktree";
  cwd?: string;
  projectId?: string;
  worktreeSlug?: string;
}

function assertOptionsAbsent(values: unknown[], message: string): void {
  if (values.some((value) => value !== undefined)) {
    throw new Error(message);
  }
}

function buildLocalWorkspaceSource(options: WorkspaceCreateOptions, path: string) {
  assertOptionsAbsent(
    [
      options.mode,
      options.worktreeSlug,
      options.newBranch,
      options.base,
      options.branch,
      options.prNumber,
      options.forge,
    ],
    "Worktree options require --isolation worktree",
  );
  return {
    kind: "directory" as const,
    path,
    ...(options.project ? { projectId: options.project } : {}),
  };
}

function buildBranchOffSource(options: WorkspaceCreateOptions, source: WorktreeSourceBase) {
  assertOptionsAbsent(
    [options.branch, options.prNumber, options.forge],
    "--branch, --pr-number, and --forge require a checkout mode",
  );
  return {
    ...source,
    action: "branch-off" as const,
    ...(options.newBranch ? { branchName: options.newBranch } : {}),
    ...(options.base ? { baseBranch: options.base } : {}),
  };
}

function buildBranchCheckoutSource(options: WorkspaceCreateOptions, source: WorktreeSourceBase) {
  if (!options.branch) {
    throw new Error("--branch is required for --mode checkout-branch");
  }
  assertOptionsAbsent(
    [options.newBranch, options.base, options.prNumber, options.forge],
    "--new-branch, --base, --pr-number, and --forge are not valid for --mode checkout-branch",
  );
  return { ...source, action: "checkout" as const, refName: options.branch };
}

function buildPullRequestCheckoutSource(
  options: WorkspaceCreateOptions,
  source: WorktreeSourceBase,
) {
  if (options.prNumber === undefined || options.prNumber === "") {
    throw new Error("--pr-number is required for --mode checkout-pr");
  }
  const prNumber = Number(options.prNumber);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error("--pr-number must be a positive integer");
  }
  assertOptionsAbsent(
    [options.newBranch, options.base, options.branch],
    "--new-branch, --base, and --branch are not valid for --mode checkout-pr",
  );
  return {
    ...source,
    action: "checkout" as const,
    checkoutSource: {
      kind: "change_request" as const,
      ...(options.forge ? { forge: options.forge } : {}),
      number: prNumber,
    },
  };
}

function buildWorktreeWorkspaceSource(options: WorkspaceCreateOptions, path: string | undefined) {
  const source: WorktreeSourceBase = {
    kind: "worktree",
    ...(path ? { cwd: path } : {}),
    ...(options.project ? { projectId: options.project } : {}),
    ...(options.worktreeSlug ? { worktreeSlug: options.worktreeSlug } : {}),
  };
  switch (options.mode ?? "branch-off") {
    case "branch-off":
      return buildBranchOffSource(options, source);
    case "checkout-branch":
      return buildBranchCheckoutSource(options, source);
    case "checkout-pr":
      return buildPullRequestCheckoutSource(options, source);
    default:
      throw new Error(`Unsupported worktree mode: ${String(options.mode)}`);
  }
}

// A relative --path names a directory relative to where the command runs, so
// it is made absolute here for a local daemon, which would otherwise resolve
// it against its own working directory. For an explicit endpoint the path is
// sent as written, the same rule as resolveRepositoryDirectory. An absolute
// path can target a daemon on a different operating system, and the daemon
// expands a leading ~ to its own home directory.
function resolveCallerPath(input: string, daemonTarget: DaemonTarget): string {
  const isHomeRelative = input === "~" || input.startsWith("~/");
  if (isHomeRelative || isPosixAbsolute(input) || isWindowsAbsolute(input)) return input;
  return daemonTarget.kind === "instance" ? resolve(input) : input;
}

export function buildWorkspaceSource(options: WorkspaceCreateOptions) {
  const callerPath =
    options.path === undefined ? undefined : resolveCallerPath(options.path, options.daemonTarget);
  if (options.isolation === "local") {
    return buildLocalWorkspaceSource(options, callerPath ?? process.cwd());
  }
  if (options.isolation === "worktree") {
    const sourcePath = callerPath ?? (options.project ? undefined : process.cwd());
    return buildWorktreeWorkspaceSource(options, sourcePath);
  }
  throw new Error(`Unsupported workspace isolation: ${String(options.isolation)}`);
}

export async function runCreateCommand(
  options: WorkspaceCreateOptions,
  _command: Command,
): Promise<SingleResult<WorkspaceRow>> {
  const host = getDaemonHost({ target: options.daemonTarget });
  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
    } satisfies CommandError;
  });

  try {
    const callerAgentId = await resolveCallerAgentId(client);
    const payload = await client.createWorkspace({
      source: buildWorkspaceSource(options),
      ...(options.title ? { title: options.title } : {}),
      ...(options.background !== undefined ? { background: options.background } : {}),
      ...(callerAgentId ? { callerAgentId } : {}),
    });
    if (!payload.workspace) {
      throw new Error(payload.error ?? "Workspace creation failed");
    }
    return { type: "single", data: toWorkspaceRow(payload.workspace), schema: workspaceSchema };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "WORKSPACE_CREATE_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
