export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Ensure the provided value only contains JSON-safe primitives.
 * Throws when undefined, functions, symbols, BigInts, etc. are found.
 */
export function ensureValidJson<T>(value: T, rootLabel: string = "root"): T {
  const seen = new Set<object>();

  const validate = (current: unknown, path: string): void => {
    if (current === undefined) {
      throw new Error(`Invalid JSON value at ${path}: undefined`);
    }

    if (current === null) {
      return;
    }

    const type = typeof current;

    if (type === "string" || type === "number" || type === "boolean") {
      return;
    }

    if (Array.isArray(current)) {
      current.forEach((item, index) =>
        validate(item, `${path}[${index}]`)
      );
      return;
    }

    if (type === "object") {
      const asObject = current as Record<string, unknown>;
      if (!seen.has(asObject)) {
        seen.add(asObject);
        for (const [key, val] of Object.entries(asObject)) {
          const nextPath = path === rootLabel ? key : `${path}.${key}`;
          validate(val, nextPath);
        }
        seen.delete(asObject);
      }
      return;
    }

    throw new Error(
      `Invalid JSON value at ${path}: ${
        type === "symbol" ? "symbol" : String(current)
      }`
    );
  };

  validate(value, rootLabel);
  return value;
}
