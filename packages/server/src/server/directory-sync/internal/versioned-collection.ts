export interface VersionedValue<T> {
  seq: number;
  value: T;
}

export interface VersionedRemoval {
  id: string;
  seq: number;
}

export interface CollectionRead<T> {
  mode: "changes" | "snapshot";
  reason?: "no_cursor" | "generation_changed" | "cursor_expired";
  headSeq: number;
  values: VersionedValue<T>[];
  removals: VersionedRemoval[];
}

export type PublishedChange<T> =
  | { kind: "upsert"; seq: number; value: T }
  | { kind: "remove"; seq: number; id: string };

interface StoredValue<T> extends VersionedValue<T> {
  fingerprint: string;
}

interface VersionedCollectionOptions<T> {
  getId(value: T): string;
  fingerprint?(value: T): string;
  maxTombstones?: number;
}

/** Owns latest-state sequencing for one directory entity type. */
export class VersionedCollection<T> {
  private readonly valuesById = new Map<string, StoredValue<T>>();
  private readonly tombstonesById = new Map<string, number>();
  private readonly getId: (value: T) => string;
  private readonly fingerprint: (value: T) => string;
  private readonly maxTombstones: number;
  private expiredThroughSeq = 0;
  private nextSeq = 0;

  constructor(options: VersionedCollectionOptions<T>) {
    this.getId = options.getId;
    this.fingerprint = options.fingerprint ?? ((value) => JSON.stringify(value));
    this.maxTombstones = options.maxTombstones ?? 5_000;
  }

  get headSeq(): number {
    return this.nextSeq;
  }

  sequenceFor(id: string): number | null {
    return this.valuesById.get(id)?.seq ?? this.tombstonesById.get(id) ?? null;
  }

  replace(value: T): Extract<PublishedChange<T>, { kind: "upsert" }> | null {
    const id = this.getId(value);
    const fingerprint = this.fingerprint(value);
    const previous = this.valuesById.get(id);
    if (previous?.fingerprint === fingerprint) return null;

    const seq = this.advance();
    this.valuesById.set(id, { seq, fingerprint, value });
    this.tombstonesById.delete(id);
    return { kind: "upsert", seq, value };
  }

  remove(id: string): Extract<PublishedChange<T>, { kind: "remove" }> | null {
    if (!this.valuesById.has(id) && this.tombstonesById.has(id)) return null;
    if (!this.valuesById.delete(id) && !this.tombstonesById.has(id)) return null;

    const seq = this.advance();
    this.tombstonesById.delete(id);
    this.tombstonesById.set(id, seq);
    this.trimTombstones();
    return { kind: "remove", seq, id };
  }

  replaceAll(values: Iterable<T>): void {
    const retainedIds = new Set<string>();
    for (const value of values) {
      const id = this.getId(value);
      retainedIds.add(id);
      this.replace(value);
    }
    for (const id of this.valuesById.keys()) {
      if (!retainedIds.has(id)) this.remove(id);
    }
  }

  readSnapshot(
    reason: "no_cursor" | "generation_changed" | "cursor_expired" = "no_cursor",
  ): CollectionRead<T> {
    return {
      mode: "snapshot",
      reason,
      headSeq: this.headSeq,
      values: this.sortedValues(),
      removals: [],
    };
  }

  readAfter(afterSeq: number): CollectionRead<T> {
    if (afterSeq < this.expiredThroughSeq || afterSeq > this.headSeq) {
      return this.readSnapshot("cursor_expired");
    }
    return {
      mode: "changes",
      headSeq: this.headSeq,
      values: this.sortedValues().filter((entry) => entry.seq > afterSeq),
      removals: Array.from(this.tombstonesById, ([id, seq]) => ({ id, seq }))
        .filter((entry) => entry.seq > afterSeq)
        .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id)),
    };
  }

  private advance(): number {
    this.nextSeq += 1;
    return this.nextSeq;
  }

  private sortedValues(): VersionedValue<T>[] {
    return Array.from(this.valuesById.values())
      .map(({ seq, value }) => ({ seq, value }))
      .sort(
        (left, right) =>
          left.seq - right.seq || this.getId(left.value).localeCompare(this.getId(right.value)),
      );
  }

  private trimTombstones(): void {
    while (this.tombstonesById.size > this.maxTombstones) {
      const oldest = this.tombstonesById.entries().next().value;
      if (!oldest) return;
      const [id, seq] = oldest;
      this.tombstonesById.delete(id);
      this.expiredThroughSeq = Math.max(this.expiredThroughSeq, seq);
    }
  }
}
