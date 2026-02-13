export type Resolvable<T> = T | (() => T);

export function toResolver<T>(value: Resolvable<T>): () => T {
  if (typeof value === "function") {
    return value as () => T;
  }
  return () => value;
}
