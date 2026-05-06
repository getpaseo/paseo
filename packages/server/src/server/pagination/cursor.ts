export interface CursorSortEntry<K extends string> {
  key: K;
  direction: "asc" | "desc";
}

export type CursorSortValue = string | number | null;

export interface DecodedCursor<K extends string> {
  sort: CursorSortEntry<K>[];
  values: Record<string, CursorSortValue>;
  id: string;
}

export class CursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorError";
  }
}

export function encodeCursor<E, K extends string>(
  entry: E,
  sort: readonly CursorSortEntry<K>[],
  getId: (entry: E) => string,
  getValue: (entry: E, key: K) => CursorSortValue,
): string {
  const values: Record<string, CursorSortValue> = {};
  for (const spec of sort) {
    values[spec.key] = getValue(entry, spec.key);
  }
  return Buffer.from(JSON.stringify({ sort, values, id: getId(entry) }), "utf8").toString(
    "base64url",
  );
}

export function decodeCursor<K extends string>(
  cursor: string,
  sort: readonly CursorSortEntry<K>[],
  validKeys: readonly K[],
  label: string,
): DecodedCursor<K> {
  const invalid = new CursorError(`Invalid ${label} cursor`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid;
  }

  if (!parsed || typeof parsed !== "object") {
    throw invalid;
  }

  const payload = parsed as { sort?: unknown; values?: unknown; id?: unknown };

  if (!Array.isArray(payload.sort) || typeof payload.id !== "string") {
    throw invalid;
  }
  if (!payload.values || typeof payload.values !== "object") {
    throw invalid;
  }

  const cursorSort = parseCursorSort(payload.sort, validKeys, label);

  if (
    cursorSort.length !== sort.length ||
    cursorSort.some(
      (entry, index) =>
        entry.key !== sort[index]?.key || entry.direction !== sort[index]?.direction,
    )
  ) {
    throw new CursorError(`${label} cursor does not match current sort`);
  }

  return {
    sort: cursorSort,
    values: payload.values as Record<string, CursorSortValue>,
    id: payload.id,
  };
}

interface RawCursorSortEntry {
  key?: unknown;
  direction?: unknown;
}

function parseCursorSort<K extends string>(
  raw: unknown[],
  validKeys: readonly K[],
  label: string,
): CursorSortEntry<K>[] {
  const result: CursorSortEntry<K>[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      throw new CursorError(`Invalid ${label} cursor`);
    }
    const { key, direction } = item as RawCursorSortEntry;
    if (typeof key !== "string" || typeof direction !== "string") {
      throw new CursorError(`Invalid ${label} cursor`);
    }
    if (
      !(validKeys as readonly string[]).includes(key) ||
      (direction !== "asc" && direction !== "desc")
    ) {
      throw new CursorError(`Invalid ${label} cursor`);
    }
    result.push({ key: key as K, direction });
  }
  return result;
}
