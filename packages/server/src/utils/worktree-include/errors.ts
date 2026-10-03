import type {
  WorktreeIncludeEntry,
  WorktreeIncludeErrorCode,
  WorktreeIncludeMaterialization,
  WorktreeIncludeSkippedEntry,
  WorktreeIncludeSkipReason,
} from "./types.js";

export class WorktreeIncludeError extends Error {
  constructor(
    public readonly code: WorktreeIncludeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorktreeIncludeError";
  }
}

export class WorktreeIncludeCleanupError extends Error {
  constructor(
    message: string,
    public readonly cleanupError: unknown,
  ) {
    super(message);
    this.name = "WorktreeIncludeCleanupError";
  }
}

export function getErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const { code } = error;
  return typeof code === "string" ? code : null;
}

export function noMatchError(
  entry: Pick<WorktreeIncludeEntry, "lineNumber" | "raw">,
): WorktreeIncludeError {
  return new WorktreeIncludeError(
    "missing_source",
    `No paths matched .worktreeinclude entry '${entry.raw}' on line ${entry.lineNumber}`,
  );
}

export function destinationConflict(
  materialization: WorktreeIncludeMaterialization,
): WorktreeIncludeError {
  return new WorktreeIncludeError(
    "conflict",
    `.worktreeinclude entry '${materialization.relativePath}' on line ${materialization.lineNumber} conflicts with the new worktree`,
  );
}

export function toSkippedEntry(
  entry: Pick<WorktreeIncludeEntry, "lineNumber" | "raw">,
  error: unknown,
): WorktreeIncludeSkippedEntry {
  return {
    lineNumber: entry.lineNumber,
    message: error instanceof Error ? error.message : String(error),
    raw: entry.raw,
    reason: getSkipReason(error),
  };
}

export function getSkipReason(error: unknown): WorktreeIncludeSkipReason {
  if (!(error instanceof WorktreeIncludeError)) {
    return "materialization";
  }
  switch (error.code) {
    case "conflict":
      return "conflict";
    case "invalid_entry":
      return "invalid";
    case "windows_symlink_unavailable":
      return "materialization";
    case "missing_source":
      return "missing";
    case "source_changed":
      return "source_changed";
    case "unsupported_source":
      return "unsafe";
  }
}

export function isSkippableWorktreeIncludeError(error: unknown): error is WorktreeIncludeError {
  return error instanceof WorktreeIncludeError && error.code !== "windows_symlink_unavailable";
}

export function isWorktreeIncludeMaterializationError(error: unknown): boolean {
  return error instanceof WorktreeIncludeError || getErrorCode(error) !== null;
}
