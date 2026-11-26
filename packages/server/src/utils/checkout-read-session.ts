export interface WorktreeRegistration {
  entries: readonly { path: string; isBare?: boolean }[];
  contains(canonicalCheckoutPath: string): Promise<boolean>;
}

/** Shares repository-wide reads for the lifetime of one checkout reconciliation pass. */
export class CheckoutReadSession {
  private readonly worktrees = new Map<string, Promise<WorktreeRegistration>>();
  private readonly mainCheckouts = new Map<string, Promise<string>>();

  readWorktrees(
    repository: string,
    read: () => Promise<WorktreeRegistration>,
  ): Promise<WorktreeRegistration> {
    return readOnce(this.worktrees, repository, read);
  }

  readMainCheckout(repository: string, read: () => Promise<string>): Promise<string> {
    return readOnce(this.mainCheckouts, repository, read);
  }
}

function readOnce<T>(
  reads: Map<string, Promise<T>>,
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  let result = reads.get(key);
  if (!result) {
    result = read().catch((error) => {
      reads.delete(key);
      throw error;
    });
    reads.set(key, result);
  }
  return result;
}
