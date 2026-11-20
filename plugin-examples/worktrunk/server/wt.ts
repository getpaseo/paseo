import { lstatSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  execCommand,
  type PluginWorktreeCreateInput,
  type PluginWorktreeRemoveRequest,
  type PluginWorktreeRestoreRequest,
} from "@getpaseo/plugin/server";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export const WORKING_MARKER = "🤖";
export const WAITING_MARKER = "💬";

interface SwitchJsonOutput {
  path: string;
  action?: string;
}

/**
 * Resolve the Worktrunk CLI executable.
 * Honors `WORKTRUNK_BIN` first; on Windows prefers `git-wt.exe` and skips the
 * WindowsApps alias that points to Windows Terminal.
 */
export function resolveWorktrunkBin(): string | null {
  const configured = process.env.WORKTRUNK_BIN?.trim();
  if (configured) return configured;
  if (process.platform !== "win32") return "wt";

  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const findOnPath = (name: string) =>
    dirs
      .map((dir) => join(dir, name))
      .find((candidate) => {
        try {
          lstatSync(candidate);
          return true;
        } catch {
          return false;
        }
      });

  if (findOnPath("git-wt.exe")) return "git-wt.exe";
  const wt = findOnPath("wt.exe");
  return wt && !/[\\/]WindowsApps[\\/]/i.test(wt) ? "wt" : null;
}

async function runWt(
  args: string[],
  options: { cwd?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const bin = resolveWorktrunkBin();
  if (!bin) {
    throw new Error(
      "Worktrunk CLI not found on PATH. Install wt (or git-wt.exe on Windows) or set WORKTRUNK_BIN.",
    );
  }
  try {
    const { stdout } = await execCommand(bin, args, {
      cwd: options.cwd,
      signal: options.signal,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || (error instanceof Error ? error.message : String(error)), {
      cause: error,
    });
  }
}

function tryParseSwitchOutput(stdout: string | undefined): SwitchJsonOutput | null {
  if (!stdout?.trim()) return null;
  try {
    const parsed = JSON.parse(stdout) as { path?: unknown; action?: unknown };
    if (typeof parsed.path !== "string" || parsed.path.length === 0) return null;
    return {
      path: parsed.path,
      ...(typeof parsed.action === "string" ? { action: parsed.action } : {}),
    };
  } catch {
    return null;
  }
}

function parseSwitchOutput(stdout: string): SwitchJsonOutput {
  const parsed = tryParseSwitchOutput(stdout);
  if (!parsed) {
    throw new Error("wt switch --format=json output did not include a worktree path");
  }
  return parsed;
}

function hookFlags(untrusted: boolean): string[] {
  // Never approve repository-defined hooks on untrusted checkouts such as fork PRs.
  return untrusted ? ["--no-hooks"] : ["--yes"];
}

export function buildCreateArgs(request: PluginWorktreeCreateInput): string[] | null {
  const common = [
    "-C",
    request.repoRoot,
    "switch",
    "--no-cd",
    ...hookFlags(request.untrusted),
    "--format=json",
  ];
  switch (request.kind) {
    case "branch-off":
      return [
        ...common,
        "--create",
        request.branch,
        "--base",
        request.startPoint ?? request.baseRef,
      ];
    case "checkout-branch":
      return [...common, request.branch];
    case "checkout-change-request":
      if (request.forge === "github") return [...common, `pr:${request.changeRequestNumber}`];
      if (request.forge === "gitlab") return [...common, `mr:${request.changeRequestNumber}`];
      return null;
    case "checkout-github-pr":
      return [...common, `pr:${request.githubPrNumber}`];
  }
}

async function cleanupPartiallyCreatedWorktree(repoRoot: string, error: unknown): Promise<void> {
  // Worktrunk prints `{ path, action: "created" }` on stdout even when a later hook exits non-zero.
  const stdout =
    error instanceof Error && error.cause && typeof error.cause === "object"
      ? (error.cause as { stdout?: string }).stdout
      : undefined;
  const parsed = tryParseSwitchOutput(stdout);
  if (!parsed || (parsed.action !== undefined && parsed.action !== "created")) return;
  await runWt([
    "-C",
    repoRoot,
    "remove",
    "--foreground",
    "--no-delete-branch",
    "--no-hooks",
    "--force",
    parsed.path,
  ]).catch(() => {});
}

export async function createWithWorktrunk(
  request: PluginWorktreeCreateInput,
  signal: AbortSignal,
): Promise<{ type: "created"; path: string } | undefined> {
  const args = buildCreateArgs(request);
  if (!args) return undefined;
  let stdout: string;
  try {
    stdout = await runWt(args, { signal });
  } catch (error) {
    await cleanupPartiallyCreatedWorktree(request.repoRoot, error);
    throw error;
  }
  const output = parseSwitchOutput(stdout);
  // If Worktrunk switched to an already-existing checkout instead of creating one,
  // decline so Paseo falls back to Git (which creates a unique branch).
  if (output.action !== undefined && output.action !== "created") {
    return undefined;
  }
  return { type: "created", path: output.path };
}

export async function removeWithWorktrunk(
  request: PluginWorktreeRemoveRequest,
  signal: AbortSignal,
): Promise<{ type: "removed" }> {
  // Run from the main repository root when available and skip repository hooks for
  // untrusted workspaces (or when repoRoot is unknown) so fork PRs cannot run hooks.
  const runDir = request.repoRoot ?? request.path;
  const skipHooks = request.untrusted || request.repoRoot === null;
  const args = [
    "-C",
    runDir,
    "remove",
    "--foreground",
    "--no-delete-branch",
    ...hookFlags(skipHooks),
    ...(request.force ? ["--force"] : []),
    request.path,
  ];
  await runWt(args, { signal });
  return { type: "removed" };
}

export async function restoreWithWorktrunk(
  request: PluginWorktreeRestoreRequest,
  signal: AbortSignal,
): Promise<{ type: "restored"; path: string } | undefined> {
  if (request.target.type === "commit") {
    // Detached-commit restores fall back to Paseo's built-in Git restore.
    return undefined;
  }
  const common = [
    "-C",
    request.repoRoot,
    "switch",
    "--path",
    request.path,
    "--no-cd",
    ...hookFlags(request.untrusted),
    "--format=json",
  ];
  const args =
    request.target.type === "branch"
      ? [...common, request.target.branch]
      : [...common, "--create", request.target.branch, "--base", request.target.baseRef];
  let stdout: string;
  try {
    stdout = await runWt(args, { signal });
  } catch (error) {
    await cleanupPartiallyCreatedWorktree(request.repoRoot, error);
    throw error;
  }
  const output = parseSwitchOutput(stdout);
  return { type: "restored", path: output.path };
}

export async function setActivityMarker(
  cwd: string,
  marker: string | null,
  signal: AbortSignal,
): Promise<void> {
  const args =
    marker === null
      ? ["config", "state", "marker", "clear"]
      : ["config", "state", "marker", "set", marker];
  try {
    await runWt(args, { cwd, signal });
  } catch {
    // Activity markers are best-effort and must not disrupt agent sessions.
  }
}
