import {
  MergeConflictError,
  MergeFromBaseConflictError,
  NotGitRepoError,
} from "../utils/checkout-git.js";
import { gitExec } from "../utils/git-process-pool.js";

export const READ_ONLY_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
};

export type CheckoutErrorCode = "NOT_GIT_REPO" | "NOT_ALLOWED" | "MERGE_CONFLICT" | "UNKNOWN";

export type CheckoutErrorPayload = {
  code: CheckoutErrorCode;
  message: string;
};

export async function resolveCheckoutGitDir(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await gitExec("git rev-parse --absolute-git-dir", {
      cwd,
      env: READ_ONLY_GIT_ENV,
    });
    const gitDir = stdout.trim();
    return gitDir.length > 0 ? gitDir : null;
  } catch {
    return null;
  }
}

export function toCheckoutError(error: unknown): CheckoutErrorPayload {
  if (error instanceof NotGitRepoError) {
    return { code: "NOT_GIT_REPO", message: error.message };
  }
  if (error instanceof MergeConflictError) {
    return { code: "MERGE_CONFLICT", message: error.message };
  }
  if (error instanceof MergeFromBaseConflictError) {
    return { code: "MERGE_CONFLICT", message: error.message };
  }
  if (error instanceof Error) {
    return { code: "UNKNOWN", message: error.message };
  }
  return { code: "UNKNOWN", message: String(error) };
}
