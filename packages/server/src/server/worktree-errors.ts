import {
  ConflictingGitHubPullRequestIntentError,
  MissingCheckoutTargetError,
} from "./resolve-worktree-creation-intent.js";
import { BranchAlreadyCheckedOutError, UnknownBranchError } from "../utils/worktree.js";

export type WorktreeWireErrorCode =
  | "branch_already_checked_out"
  | "missing_checkout_target"
  | "conflicting_github_pull_request_intent"
  | "unknown_branch"
  | "unknown";

export interface WorktreeWireError {
  code: WorktreeWireErrorCode;
  message: string;
}

export class WorktreeRequestError extends Error {
  readonly code: WorktreeWireErrorCode;

  constructor(error: WorktreeWireError) {
    super(error.message);
    this.name = "WorktreeRequestError";
    this.code = error.code;
  }
}

export function toWorktreeWireError(error: unknown): WorktreeWireError {
  if (error instanceof BranchAlreadyCheckedOutError) {
    return { code: "branch_already_checked_out", message: error.message };
  }
  if (error instanceof MissingCheckoutTargetError) {
    return { code: "missing_checkout_target", message: error.message };
  }
  if (error instanceof ConflictingGitHubPullRequestIntentError) {
    return { code: "conflicting_github_pull_request_intent", message: error.message };
  }
  if (error instanceof UnknownBranchError) {
    return { code: "unknown_branch", message: error.message };
  }
  if (error instanceof Error) {
    return { code: "unknown", message: error.message };
  }
  return { code: "unknown", message: String(error) };
}

export function toWorktreeRequestError(error: unknown): WorktreeRequestError {
  return new WorktreeRequestError(toWorktreeWireError(error));
}
