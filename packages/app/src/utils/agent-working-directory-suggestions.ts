import { isPaseoWorktreePath } from "@/utils/paseo-worktree-path";

export interface AgentWorkingDirectorySource {
  cwd?: string | null;
  createdAt?: Date | null;
  lastActivityAt?: Date | null;
}

export interface AgentWorkingDirectorySuggestionOptions {
  /** The daemon's resolved worktrees base root (`server_info.worktreesRoot`). */
  worktreesRoot?: string | null;
}

/**
 * Recently used working directories, most recent first. Paseo-managed worktrees are left
 * out — they are created per agent, so offering one back is never what the user wants.
 */
export function collectAgentWorkingDirectorySuggestions(
  sources: Iterable<AgentWorkingDirectorySource>,
  options?: AgentWorkingDirectorySuggestionOptions,
): string[] {
  const lastSeenByPath = new Map<string, number>();

  for (const source of sources) {
    const cwd = source.cwd?.trim();
    if (!cwd) {
      continue;
    }
    if (isPaseoWorktreePath(cwd, options?.worktreesRoot)) {
      continue;
    }

    const timestamp = toEpochMs(source.lastActivityAt ?? source.createdAt);
    const previous = lastSeenByPath.get(cwd);
    if (previous === undefined || timestamp > previous) {
      lastSeenByPath.set(cwd, timestamp);
    }
  }

  return Array.from(lastSeenByPath.entries())
    .sort((left, right) => {
      const timeDiff = right[1] - left[1];
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return left[0].localeCompare(right[0]);
    })
    .map(([cwd]) => cwd);
}

function toEpochMs(date: Date | null | undefined): number {
  if (!(date instanceof Date)) {
    return 0;
  }
  const value = date.getTime();
  return Number.isFinite(value) ? value : 0;
}
