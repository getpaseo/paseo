import type { TFunction } from "i18next";
import type { ComboboxOption } from "@/components/ui/combobox";

/**
 * Create-time placement for a new workspace. `local` reuses the project's
 * checkout, `worktree` cuts a fresh one, and `existing-worktree` backs the
 * workspace with a worktree that is already on disk — Paseo-made or cut by
 * hand. Only the first two are remembered as a form preference: a path can be
 * gone by the next visit, so an existing worktree is a per-visit choice.
 */
export type WorkspaceIsolation =
  | { kind: "local" }
  | { kind: "worktree" }
  | { kind: "existing-worktree"; path: string };

export interface ExistingWorktree {
  path: string;
  branchName: string | null;
}

export const LOCAL_ISOLATION: WorkspaceIsolation = { kind: "local" };
export const NEW_WORKTREE_ISOLATION: WorkspaceIsolation = { kind: "worktree" };

const EXISTING_OPTION_PREFIX = "existing-worktree:";

function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function samePath(left: string, right: string): boolean {
  return trimTrailingSlash(left) === trimTrailingSlash(right);
}

export function worktreeDisplayName(worktree: ExistingWorktree): string {
  if (worktree.branchName) return worktree.branchName;
  const segments = trimTrailingSlash(worktree.path).split("/");
  return segments[segments.length - 1] || worktree.path;
}

export function isolationOptionId(isolation: WorkspaceIsolation): string {
  return isolation.kind === "existing-worktree"
    ? `${EXISTING_OPTION_PREFIX}${isolation.path}`
    : isolation.kind;
}

export function isolationFromOptionId(id: string): WorkspaceIsolation {
  if (id.startsWith(EXISTING_OPTION_PREFIX)) {
    return { kind: "existing-worktree", path: id.slice(EXISTING_OPTION_PREFIX.length) };
  }
  return id === "worktree" ? NEW_WORKTREE_ISOLATION : LOCAL_ISOLATION;
}

/**
 * The worktrees worth offering: the main working tree is already the Local
 * option, and the project's own source directory is whatever Local resolves to
 * on this host — offering either again would create a second workspace on a
 * directory the picker above it already covers.
 */
export function selectExistingWorktrees(input: {
  worktrees: readonly {
    worktreePath: string;
    branchName?: string | null;
    isMainWorktree?: boolean;
  }[];
  sourceDirectory: string | null;
}): ExistingWorktree[] {
  return input.worktrees
    .filter((entry) => !entry.isMainWorktree)
    .filter(
      (entry) => !input.sourceDirectory || !samePath(entry.worktreePath, input.sourceDirectory),
    )
    .map((entry) => ({ path: entry.worktreePath, branchName: entry.branchName ?? null }));
}

export function buildIsolationOptions(input: {
  t: TFunction;
  canCreateWorktree: boolean;
  existingWorktrees: readonly ExistingWorktree[];
}): ComboboxOption[] {
  const options: ComboboxOption[] = [
    { id: "local", label: input.t("newWorkspace.isolation.local") },
  ];
  if (input.canCreateWorktree) {
    options.push({ id: "worktree", label: input.t("newWorkspace.isolation.worktree") });
  }
  const section = input.t("newWorkspace.isolation.existingSection");
  for (const worktree of input.existingWorktrees) {
    options.push({
      id: isolationOptionId({ kind: "existing-worktree", path: worktree.path }),
      label: worktreeDisplayName(worktree),
      description: worktree.path,
      section,
    });
  }
  return options;
}

/**
 * Drops a choice the current project can no longer honour: an existing worktree
 * that has since been removed, or a new worktree on a project that doesn't
 * support them. Both fall back to Local rather than blocking the form.
 */
export function resolveIsolation(input: {
  isolation: WorkspaceIsolation;
  canCreateWorktree: boolean;
  existingWorktrees: readonly ExistingWorktree[];
}): WorkspaceIsolation {
  if (input.isolation.kind === "worktree") {
    return input.canCreateWorktree ? NEW_WORKTREE_ISOLATION : LOCAL_ISOLATION;
  }
  if (input.isolation.kind === "existing-worktree") {
    const path = input.isolation.path;
    return input.existingWorktrees.some((worktree) => samePath(worktree.path, path))
      ? input.isolation
      : LOCAL_ISOLATION;
  }
  return LOCAL_ISOLATION;
}

export function isolationLabel(input: {
  t: TFunction;
  isolation: WorkspaceIsolation;
  existingWorktrees: readonly ExistingWorktree[];
}): string {
  const { t, isolation, existingWorktrees } = input;
  if (isolation.kind === "worktree") return t("newWorkspace.isolation.worktree");
  if (isolation.kind === "existing-worktree") {
    const match = existingWorktrees.find((worktree) => samePath(worktree.path, isolation.path));
    return match ? worktreeDisplayName(match) : t("newWorkspace.isolation.local");
  }
  return t("newWorkspace.isolation.local");
}
