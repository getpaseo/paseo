import type { ProjectDescriptor, WorkspaceDescriptor } from "@/stores/session-store";
import { shortenPath } from "@/utils/shorten-path";

/** A git project on one host that a goal can run on. */
export interface GoalProjectOption {
  projectId: string;
  name: string;
  /** The project's checkout; choosing the project runs the goal here. */
  rootPath: string;
  /** Root plus every workspace directory of the project, such as its worktrees. */
  directories: string[];
  /** Newest prompt or workspace creation in the project, in ms; null when it has no workspace. */
  lastUsedAt: number | null;
}

export interface GoalProjectSource {
  projects: Iterable<
    Pick<ProjectDescriptor, "projectId" | "projectDisplayName" | "projectRootPath" | "projectKind">
  >;
  workspaces: Iterable<
    Pick<
      WorkspaceDescriptor,
      "projectId" | "workspaceDirectory" | "lastUserMessageAt" | "createdAt"
    >
  >;
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  return trimmed.length > 1 ? trimmed.replace(/[\\/]+$/, "") : trimmed;
}

function compareProjects(left: GoalProjectOption, right: GoalProjectOption): number {
  const byRecency = (right.lastUsedAt ?? -1) - (left.lastUsedAt ?? -1);
  if (byRecency !== 0) {
    return byRecency;
  }
  return (
    left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true }) ||
    left.rootPath.localeCompare(right.rootPath)
  );
}

/**
 * The host's git projects, most recently used first. Goals need a git repository, so plain
 * directories are left out.
 */
export function buildGoalProjectOptions(source: GoalProjectSource): GoalProjectOption[] {
  const byId = new Map<string, GoalProjectOption>();
  for (const project of source.projects) {
    const rootPath = normalizePath(project.projectRootPath);
    if (project.projectKind !== "git" || !rootPath) {
      continue;
    }
    byId.set(project.projectId, {
      projectId: project.projectId,
      name: project.projectDisplayName.trim() || basename(rootPath),
      rootPath,
      directories: [rootPath],
      lastUsedAt: null,
    });
  }
  for (const workspace of source.workspaces) {
    const option = byId.get(workspace.projectId);
    if (!option) {
      continue;
    }
    const directory = normalizePath(workspace.workspaceDirectory);
    if (directory && !option.directories.includes(directory)) {
      option.directories.push(directory);
    }
    const usedAt = (workspace.lastUserMessageAt ?? workspace.createdAt)?.getTime() ?? null;
    if (usedAt !== null && (option.lastUsedAt === null || usedAt > option.lastUsedAt)) {
      option.lastUsedAt = usedAt;
    }
  }
  return [...byId.values()].sort(compareProjects);
}

function isInside(path: string, root: string): boolean {
  return path.startsWith(`${root}/`) || path.startsWith(`${root}\\`);
}

/**
 * The project a directory belongs to: its root or one of its workspaces, or else the project
 * whose root contains it most closely.
 */
export function findGoalProject(
  options: readonly GoalProjectOption[],
  cwd: string,
): GoalProjectOption | null {
  const path = normalizePath(cwd);
  if (!path) {
    return null;
  }
  const exact = options.find((option) => option.directories.includes(path));
  if (exact) {
    return exact;
  }
  let best: GoalProjectOption | null = null;
  for (const option of options) {
    const root = option.directories.find((directory) => isInside(path, directory));
    if (root && (!best || option.rootPath.length > best.rootPath.length)) {
      best = option;
    }
  }
  return best;
}

export function basename(path: string): string {
  const normalized = normalizePath(path);
  const parts = normalized.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? normalized;
}

export interface GoalProjectLabel {
  /** The project's name, or the folder's name when the host does not list it as a project. */
  name: string;
  /** The directory, with the home directory shortened to ~. */
  path: string;
  known: boolean;
}

/** Names a goal's directory for display; null for a goal without one (manual). */
export function describeGoalProject(
  options: readonly GoalProjectOption[],
  cwd: string | null | undefined,
): GoalProjectLabel | null {
  const path = normalizePath(cwd ?? "");
  if (!path) {
    return null;
  }
  const project = findGoalProject(options, path);
  return {
    name: project?.name ?? basename(path),
    path: shortenPath(path),
    known: project !== null,
  };
}

export type GoalCwdSource = "prefill" | "memory" | "recent" | "manual" | "none";

/**
 * Where a new goal starts: the directory you opened the form from (a chat or the workspace you
 * were in) wins, then the project you used last on this host, then the host's most recently
 * used project.
 */
export function resolveGoalProjectDefault(input: {
  prefillCwd?: string | null;
  rememberedCwd?: string | null;
  options: readonly GoalProjectOption[];
}): { cwd: string; source: GoalCwdSource } {
  const prefill = input.prefillCwd?.trim();
  if (prefill) {
    return { cwd: prefill, source: "prefill" };
  }
  const remembered = input.rememberedCwd?.trim();
  if (remembered) {
    return { cwd: remembered, source: "memory" };
  }
  const recent = input.options[0];
  return recent ? { cwd: recent.rootPath, source: "recent" } : { cwd: "", source: "none" };
}

/** What the host said about the chosen directory. */
export type GoalCwdCheck =
  | { cwd: string; status: "checking" }
  | { cwd: string; status: "git"; branch: string | null; dirty: boolean }
  | { cwd: string; status: "notGit" };

/** Reads a checkout status reply; null payload means the reply has not arrived. */
export function goalCwdCheckFromStatus(
  cwd: string,
  payload: { isGit: boolean; currentBranch: string | null; isDirty: boolean | null } | null,
): GoalCwdCheck {
  if (!payload) {
    return { cwd, status: "checking" };
  }
  if (!payload.isGit) {
    return { cwd, status: "notGit" };
  }
  const branch = payload.currentBranch?.trim();
  return {
    cwd,
    status: "git",
    branch: branch && branch !== "HEAD" ? branch : null,
    dirty: payload.isDirty === true,
  };
}

export const GOAL_PROJECT_FILTER_ALL = "all";
const NO_PROJECT_KEY = "none";

export interface GoalProjectFilterOption {
  key: string;
  name: string;
  path: string | null;
  count: number;
}

function goalProjectKey(options: readonly GoalProjectOption[], cwd: string | undefined): string {
  const path = normalizePath(cwd ?? "");
  if (!path) {
    return NO_PROJECT_KEY;
  }
  const project = findGoalProject(options, path);
  return project ? `project:${project.projectId}` : `path:${path}`;
}

/**
 * The projects the goals span, in order of their newest goal; a goal without a directory
 * (manual) counts under `noProjectName`.
 */
export function buildGoalProjectFilterOptions(
  goals: readonly { config: { cwd: string } | null; updatedAt: string }[],
  options: readonly GoalProjectOption[],
  noProjectName: string,
): GoalProjectFilterOption[] {
  const byKey = new Map<string, GoalProjectFilterOption & { newest: string }>();
  for (const goal of goals) {
    const key = goalProjectKey(options, goal.config?.cwd);
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      if (goal.updatedAt > existing.newest) {
        existing.newest = goal.updatedAt;
      }
      continue;
    }
    const label = describeGoalProject(options, goal.config?.cwd);
    const project = goal.config ? findGoalProject(options, goal.config.cwd) : null;
    byKey.set(key, {
      key,
      name: label?.name ?? noProjectName,
      path: project ? shortenPath(project.rootPath) : (label?.path ?? null),
      count: 1,
      newest: goal.updatedAt,
    });
  }
  return [...byKey.values()]
    .sort((left, right) => right.newest.localeCompare(left.newest))
    .map((option) => ({
      key: option.key,
      name: option.name,
      path: option.path,
      count: option.count,
    }));
}

/** The goals in one project; an unknown or "all" key keeps every goal. */
export function filterGoalsByProject<T extends { config: { cwd: string } | null }>(
  goals: readonly T[],
  options: readonly GoalProjectOption[],
  key: string,
): readonly T[] {
  if (key === GOAL_PROJECT_FILTER_ALL) {
    return goals;
  }
  const matching = goals.filter((goal) => goalProjectKey(options, goal.config?.cwd) === key);
  return matching.length > 0 ? matching : goals;
}
