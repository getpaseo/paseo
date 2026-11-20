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

function parseSwitchPath(stdout: string): string {
  const parsed = JSON.parse(stdout) as { path?: unknown };
  if (typeof parsed.path !== "string" || parsed.path.length === 0) {
    throw new Error("wt switch --format=json output did not include a worktree path");
  }
  return parsed.path;
}

export function buildCreateArgs(request: PluginWorktreeCreateInput): string[] | null {
  const common = ["-C", request.repoRoot, "switch", "--no-cd", "--yes", "--format=json"];
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

export async function createWithWorktrunk(
  request: PluginWorktreeCreateInput,
  signal: AbortSignal,
): Promise<{ type: "created"; path: string } | undefined> {
  const args = buildCreateArgs(request);
  if (!args) return undefined;
  const stdout = await runWt(args, { signal });
  return { type: "created", path: parseSwitchPath(stdout) };
}

export async function removeWithWorktrunk(
  request: PluginWorktreeRemoveRequest,
  signal: AbortSignal,
): Promise<{ type: "removed" }> {
  // Keep the local branch on archive so Paseo's restore flow can recreate the worktree.
  const args = [
    "-C",
    request.path,
    "remove",
    "--foreground",
    "--no-delete-branch",
    "--yes",
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
    "--yes",
    "--format=json",
  ];
  const args =
    request.target.type === "branch"
      ? [...common, request.target.branch]
      : [...common, "--create", request.target.branch, "--base", request.target.baseRef];
  const stdout = await runWt(args, { signal });
  return { type: "restored", path: parseSwitchPath(stdout) };
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
