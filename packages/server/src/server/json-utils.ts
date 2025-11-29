export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Coerce arbitrary values into JSON-safe structures.
 * Unlike the previous implementation, this never throws on undefined—
 * it replaces unsupported values (undefined, functions, symbols) with null
 * so responses always make it back to the client.
 */
export function ensureValidJson<T>(value: T): T {
  const seen = new WeakSet<object>();

  const sanitize = (current: unknown): JsonValue => {
    if (current === null || current === undefined) {
      return null;
    }

    if (typeof current === "string" || typeof current === "number") {
      return current;
    }

    if (typeof current === "boolean") {
      return current;
    }

    if (typeof current === "bigint") {
      return current.toString();
    }

    if (current instanceof Date) {
      return current.toISOString();
    }

    if (Array.isArray(current)) {
      return current.map((item) => sanitize(item));
    }

    if (typeof current === "object") {
      if (seen.has(current as object)) {
        throw new Error("Cannot serialize circular structure to JSON");
      }
      seen.add(current as object);
      const obj: Record<string, JsonValue> = {};
      for (const [key, val] of Object.entries(current as Record<string, unknown>)) {
        obj[key] = sanitize(val);
      }
      seen.delete(current as object);
      return obj;
    }

    // functions, symbols, undefined, etc.
    return null;
  };

  return sanitize(value) as T;
}
