export interface AgentWorkingDirectorySource {
  cwd?: string | null;
  createdAt?: Date | null;
  lastActivityAt?: Date | null;
}

const PASEO_WORKTREE_PATH_PATTERN = /(^|\/)\.paseo\/worktrees(\/|$)/;

export function collectAgentWorkingDirectorySuggestions(
  sources: Iterable<AgentWorkingDirectorySource>
): string[] {
  const lastSeenByPath = new Map<string, number>();

  for (const source of sources) {
    const cwd = source.cwd?.trim();
    if (!cwd) {
      continue;
    }
    if (isPaseoOwnedWorktreePath(cwd)) {
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

function isPaseoOwnedWorktreePath(cwd: string): boolean {
  return PASEO_WORKTREE_PATH_PATTERN.test(cwd.replace(/\\/g, "/"));
}

function toEpochMs(date: Date | null | undefined): number {
  if (!(date instanceof Date)) {
    return 0;
  }
  const value = date.getTime();
  return Number.isFinite(value) ? value : 0;
}
