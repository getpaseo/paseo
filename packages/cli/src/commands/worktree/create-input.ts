import type { DaemonClient } from "@getpaseo/server";
import type { CommandError, CommandOptions } from "../../output/index.js";

export interface WorktreeCreateOptions extends CommandOptions {
  host?: string;
  cwd?: string;
  mode?: string;
  newBranch?: string;
  base?: string;
  branch?: string;
  prNumber?: string;
}

const VALID_MODES = ["branch-off", "checkout-branch", "checkout-pr"] as const;

type CreatePaseoWorktreeRequest = Parameters<DaemonClient["createPaseoWorktree"]>[0];

export function buildCreateWorktreeRequest(
  options: WorktreeCreateOptions,
  cwd: string,
): CreatePaseoWorktreeRequest {
  const mode = options.mode;
  if (!mode) {
    throw cmdError(
      "MISSING_MODE",
      "--mode is required",
      `Expected one of: ${VALID_MODES.join(", ")}`,
    );
  }

  switch (mode) {
    case "branch-off":
      return buildBranchOffRequest(options, cwd);
    case "checkout-branch":
      return buildCheckoutBranchRequest(options, cwd);
    case "checkout-pr":
      return buildCheckoutPrRequest(options, cwd);
    default:
      throw cmdError(
        "INVALID_MODE",
        `Invalid --mode: ${mode}`,
        `Expected one of: ${VALID_MODES.join(", ")}`,
      );
  }
}

function buildBranchOffRequest(
  options: WorktreeCreateOptions,
  cwd: string,
): CreatePaseoWorktreeRequest {
  if (!options.newBranch) {
    throw cmdError("MISSING_NEW_BRANCH", "--new-branch is required for --mode branch-off");
  }

  return {
    cwd,
    worktreeSlug: options.newBranch,
    action: "branch-off",
    ...(options.base ? { refName: options.base } : {}),
  };
}

function buildCheckoutBranchRequest(
  options: WorktreeCreateOptions,
  cwd: string,
): CreatePaseoWorktreeRequest {
  if (!options.branch) {
    throw cmdError("MISSING_BRANCH", "--branch is required for --mode checkout-branch");
  }

  return {
    cwd,
    action: "checkout",
    refName: options.branch,
  };
}

function buildCheckoutPrRequest(
  options: WorktreeCreateOptions,
  cwd: string,
): CreatePaseoWorktreeRequest {
  if (options.prNumber === undefined || options.prNumber === "") {
    throw cmdError("MISSING_PR_NUMBER", "--pr-number is required for --mode checkout-pr");
  }

  const prNumber = Number(options.prNumber);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw cmdError(
      "INVALID_PR_NUMBER",
      `Invalid --pr-number: ${options.prNumber}`,
      "Expected a positive integer",
    );
  }

  return {
    cwd,
    action: "checkout",
    githubPrNumber: prNumber,
  };
}

function cmdError(code: string, message: string, details?: string): CommandError {
  return details ? { code, message, details } : { code, message };
}
