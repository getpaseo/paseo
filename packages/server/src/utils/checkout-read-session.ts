type RegisteredWorktreeLookup = (canonicalCheckoutPath: string) => Promise<boolean>;

/** Shares repository-wide reads for the lifetime of one checkout reconciliation pass. */
export class CheckoutReadSession {
  private readonly worktrees = new Map<string, Promise<RegisteredWorktreeLookup>>();

  readWorktrees(
    repository: string,
    read: () => Promise<RegisteredWorktreeLookup>,
  ): Promise<RegisteredWorktreeLookup> {
    let lookup = this.worktrees.get(repository);
    if (!lookup) {
      lookup = read().catch((error) => {
        this.worktrees.delete(repository);
        throw error;
      });
      this.worktrees.set(repository, lookup);
    }
    return lookup;
  }
}
