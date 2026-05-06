import {
  CursorError,
  type CursorSortValue,
  type DecodedCursor,
  decodeCursor,
  encodeCursor,
} from "./cursor.js";

export interface SortSpec<K extends string> {
  key: K;
  direction: "asc" | "desc";
}

export interface SortablePagerConfig<TItem, K extends string> {
  validKeys: readonly K[];
  defaultSort: readonly SortSpec<K>[];
  label: string;
  getId: (item: TItem) => string;
  getSortValue: (item: TItem, key: K) => CursorSortValue;
}

export class SortablePager<TItem, K extends string> {
  constructor(private readonly config: SortablePagerConfig<TItem, K>) {}

  normalizeSort(sort: readonly SortSpec<K>[] | undefined): SortSpec<K>[] {
    if (!sort || sort.length === 0) {
      return [...this.config.defaultSort];
    }
    const deduped: SortSpec<K>[] = [];
    const seen = new Set<string>();
    for (const entry of sort) {
      if (seen.has(entry.key)) {
        continue;
      }
      seen.add(entry.key);
      deduped.push(entry);
    }
    return deduped.length > 0 ? deduped : [...this.config.defaultSort];
  }

  compare(left: TItem, right: TItem, sort: readonly SortSpec<K>[]): number {
    for (const spec of sort) {
      const leftValue = this.config.getSortValue(left, spec.key);
      const rightValue = this.config.getSortValue(right, spec.key);
      const base = compareValues(leftValue, rightValue);
      if (base === 0) {
        continue;
      }
      return spec.direction === "asc" ? base : -base;
    }
    return this.config.getId(left).localeCompare(this.config.getId(right));
  }

  compareWithCursor(item: TItem, cursor: DecodedCursor<K>, sort: readonly SortSpec<K>[]): number {
    for (const spec of sort) {
      const leftValue = this.config.getSortValue(item, spec.key);
      const rightValue = cursor.values[spec.key] ?? null;
      const base = compareValues(leftValue, rightValue);
      if (base === 0) {
        continue;
      }
      return spec.direction === "asc" ? base : -base;
    }
    return this.config.getId(item).localeCompare(cursor.id);
  }

  encode(item: TItem, sort: readonly SortSpec<K>[]): string {
    return encodeCursor(item, sort, this.config.getId, this.config.getSortValue);
  }

  decode(token: string, sort: readonly SortSpec<K>[]): DecodedCursor<K> {
    return decodeCursor(token, sort, this.config.validKeys, this.config.label);
  }
}

export { CursorError };

export function compareValues(left: CursorSortValue, right: CursorSortValue): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return -1;
  }
  if (right === null) {
    return 1;
  }
  if (typeof left === "number" && typeof right === "number") {
    return left < right ? -1 : 1;
  }
  return String(left).localeCompare(String(right));
}
