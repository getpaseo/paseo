/** Only commits introduced by the request establish workspace ownership. */
export function pullRequestContainsCommit(input: {
  workspaceCommit?: string;
  pullRequestCommits?: readonly string[];
}): boolean {
  return !!input.workspaceCommit && !!input.pullRequestCommits?.includes(input.workspaceCommit);
}

/** Terminal commit lists are immutable for a request head. Failed reads remain retryable. */
export function createPullRequestCommitReader() {
  const cache = new Map<string, Promise<string[]>>();
  return (key: string, load: () => Promise<string[]>): Promise<string[]> => {
    const existing = cache.get(key);
    if (existing) return existing;
    const commits = load().catch(() => {
      cache.delete(key);
      return [];
    });
    cache.set(key, commits);
    if (cache.size > 1024) cache.delete(cache.keys().next().value!);
    return commits;
  };
}
