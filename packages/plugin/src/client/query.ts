interface GroupDescriptor {
  readonly key: string;
  readonly title?: string;
  readonly color?: string;
}

export type GroupKey = string | GroupDescriptor;

export interface Query<Snapshot> {
  readonly hosts?: readonly string[];
  readonly where?: (item: Snapshot) => boolean;
  readonly orderBy?:
    | keyof Snapshot
    | readonly [keyof Snapshot, "asc" | "desc"]
    | ((a: Snapshot, b: Snapshot) => number);
  readonly groupBy?: (item: Snapshot) => GroupKey | readonly GroupKey[];
}

export interface Group<Ref> {
  readonly key: string;
  readonly title: string | null;
  readonly color: string | null;
  readonly items: readonly Ref[];
}

function groupKeys(value: GroupKey | readonly GroupKey[]): readonly GroupKey[] {
  if (typeof value === "string") return [value];
  if ("key" in value) return [value];
  return value;
}

interface Referenced {
  readonly hostId: string;
  readonly ref: unknown;
}

function sameSequence<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function compareValues(left: unknown, right: unknown, direction: number): number {
  if (Object.is(left, right)) return 0;
  if (left === null || left === undefined) return 1;
  if (right === null || right === undefined) return -1;
  if (typeof left === "number" && typeof right === "number") return (left - right) * direction;
  return String(left).localeCompare(String(right)) * direction;
}

/** A hook owns one projection; sharing survives both source and query changes. */
export function createCollectionQuery<Snapshot extends Referenced>() {
  type Ref = Snapshot["ref"];
  let previousItems: readonly Ref[] = Object.freeze([]);
  let previousGroups: readonly Group<Ref>[] = Object.freeze([]);

  return function project(
    snapshots: readonly Snapshot[],
    query: Query<Snapshot> = {},
  ): readonly Ref[] | readonly Group<Ref>[] {
    const items = snapshots.filter((item) => {
      if (query.hosts && !query.hosts.includes(item.hostId)) return false;
      return !query.where || query.where(item);
    });
    const order = query.orderBy;
    if (typeof order === "function") items.sort(order);
    else if (order !== undefined) {
      const field = typeof order === "object" ? order[0] : order;
      const direction = typeof order === "object" && order[1] === "desc" ? -1 : 1;
      items.sort((a, b) => compareValues(a[field], b[field], direction));
    }
    if (!query.groupBy) {
      const refs = items.map((item) => item.ref);
      if (!sameSequence(previousItems, refs)) previousItems = Object.freeze(refs);
      return previousItems;
    }
    const groups = new Map<
      string,
      { key: string; title: string | null; color: string | null; items: Ref[] }
    >();
    for (const item of items) {
      const grouping = query.groupBy(item);
      const keys = groupKeys(grouping);
      const seen = new Set<string>();
      for (const value of keys) {
        const descriptor = typeof value === "string" ? { key: value } : value;
        if (seen.has(descriptor.key)) continue;
        seen.add(descriptor.key);
        let group = groups.get(descriptor.key);
        if (!group) {
          group = {
            key: descriptor.key,
            title: descriptor.title ?? null,
            color: descriptor.color ?? null,
            items: [],
          };
          groups.set(descriptor.key, group);
        }
        group.items.push(item.ref);
      }
    }
    const oldGroups = new Map(previousGroups.map((group) => [group.key, group]));
    const nextGroups = Array.from(groups.values(), (group) => {
      const previous = oldGroups.get(group.key);
      if (
        previous &&
        previous.title === group.title &&
        previous.color === group.color &&
        sameSequence(previous.items, group.items)
      )
        return previous;
      return Object.freeze({ ...group, items: Object.freeze(group.items) });
    });
    if (!sameSequence(previousGroups, nextGroups)) previousGroups = Object.freeze(nextGroups);
    return previousGroups;
  };
}
