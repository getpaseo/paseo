export interface DirectorySourceToken {
  clientGeneration: number;
  connectionEpoch: number;
}

export interface DirectoryTransaction<TSnapshot, TDelta> {
  readonly source: DirectorySourceToken;
  readonly snapshot: TSnapshot;
  readonly deltas: TDelta[];
}

export type DirectoryTransactionCompletion<TSnapshot, TDelta> =
  | { kind: "stale" }
  | { kind: "current"; snapshot: TSnapshot; deltas: readonly TDelta[] };

function isSameSource(left: DirectorySourceToken, right: DirectorySourceToken): boolean {
  return (
    left.clientGeneration === right.clientGeneration &&
    left.connectionEpoch === right.connectionEpoch
  );
}

/** Owns the shared begin/record/supersede/complete lifecycle for a directory replica. */
export class DirectoryTransactionOwner<TSnapshot, TDelta> {
  private current: DirectoryTransaction<TSnapshot, TDelta> | null = null;

  begin(
    source: DirectorySourceToken,
    createSnapshot: () => TSnapshot,
  ): DirectoryTransaction<TSnapshot, TDelta> {
    const transaction: DirectoryTransaction<TSnapshot, TDelta> = {
      source,
      snapshot: createSnapshot(),
      deltas:
        this.current && isSameSource(this.current.source, source) ? [...this.current.deltas] : [],
    };
    this.current = transaction;
    return transaction;
  }

  record(source: DirectorySourceToken, delta: TDelta): boolean {
    if (!this.current || !isSameSource(this.current.source, source)) return false;
    this.current.deltas.push(delta);
    return true;
  }

  isCurrent(transaction: DirectoryTransaction<TSnapshot, TDelta>): boolean {
    return this.current === transaction;
  }

  complete(
    transaction: DirectoryTransaction<TSnapshot, TDelta>,
  ): DirectoryTransactionCompletion<TSnapshot, TDelta> {
    if (this.current !== transaction) return { kind: "stale" };
    this.current = null;
    return { kind: "current", snapshot: transaction.snapshot, deltas: transaction.deltas };
  }

  fail(transaction: DirectoryTransaction<TSnapshot, TDelta>): readonly TDelta[] | null {
    const completion = this.complete(transaction);
    return completion.kind === "current" ? completion.deltas : null;
  }

  abort(): readonly TDelta[] {
    if (!this.current) return [];
    const deltas = [...this.current.deltas];
    this.current = null;
    return deltas;
  }
}
