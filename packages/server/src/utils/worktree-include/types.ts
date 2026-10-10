export type WorktreeIncludeMode = "copy" | "symlink";
export type WorktreeIncludeSourceKind = "file" | "directory";
export type WorktreeIncludeErrorCode =
  | "conflict"
  | "invalid_entry"
  | "missing_source"
  | "source_changed"
  | "unsupported_source"
  | "windows_symlink_unavailable";

export type WorktreeIncludeSkipReason =
  | "conflict"
  | "invalid"
  | "materialization"
  | "missing"
  | "source_changed"
  | "unsafe";

export interface WorktreeIncludeEntry {
  lineNumber: number;
  mode: WorktreeIncludeMode;
  raw: string;
  relativePath: string;
}

export interface WorktreeIncludeMaterialization {
  lineNumber: number;
  mode: WorktreeIncludeMode;
  raw: string;
  relativePath: string;
  sourceKind: WorktreeIncludeSourceKind;
}

export interface WorktreeIncludeSkippedEntry {
  lineNumber: number;
  message: string;
  raw: string;
  reason: WorktreeIncludeSkipReason;
}

export interface WorktreeIncludeSummary {
  materialized: number;
  skipped: WorktreeIncludeSkippedEntry[];
}

export interface WorktreeIncludePlan {
  excludedSourceRoots: string[];
  materializations: WorktreeIncludeMaterialization[];
  skipped: WorktreeIncludeSkippedEntry[];
  sourceRoot: string;
}

export interface ReadWorktreeIncludePlanOptions {
  excludedSourceRoots?: string[];
  sourceRoot: string;
}

export interface MaterializeWorktreeIncludePlanOptions {
  plan: WorktreeIncludePlan;
  worktreeRoot: string;
}

export interface ResolvedWorktreeIncludeMaterialization {
  materialization: WorktreeIncludeMaterialization;
  sourcePath: string;
}

export interface StagedWorktreeIncludeMaterialization {
  directoryPath: string;
  entryPath: string;
}

export interface ParsedWorktreeIncludeEntries {
  entries: WorktreeIncludeEntry[];
  skipped: WorktreeIncludeSkippedEntry[];
}

export interface NormalizedWorktreeIncludeMaterializations {
  materializations: WorktreeIncludeMaterialization[];
  skipped: WorktreeIncludeSkippedEntry[];
}

export interface WorktreeIncludeCandidateCollection {
  candidates: string[];
  errorsByPattern: Map<string, unknown>;
}
