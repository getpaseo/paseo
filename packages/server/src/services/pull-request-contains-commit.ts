/** Only commits introduced by the request establish workspace ownership. */
export function pullRequestContainsCommit(input: {
  workspaceCommit?: string;
  pullRequestCommits?: readonly string[];
}): boolean {
  return !!input.workspaceCommit && !!input.pullRequestCommits?.includes(input.workspaceCommit);
}

/** Cache immutable terminal-request commit lists, including failed reads, across polls. */
export function createPullRequestCommitReader(now: () => number = Date.now) {
  const cache = new Map<string, { expiresAt: number; commits: Promise<string[]> }>();
  return (key: string, load: () => Promise<string[]>): Promise<string[]> => {
    const existing = cache.get(key);
    if (existing && existing.expiresAt > now()) return existing.commits;
    const entry = { expiresAt: now() + 300_000, commits: load() };
    cache.delete(key);
    cache.set(key, entry);
    if (cache.size > 1024) cache.delete(cache.keys().next().value!);
    return entry.commits;
  };
}
