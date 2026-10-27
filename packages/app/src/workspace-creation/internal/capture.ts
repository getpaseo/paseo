/** Creation input is plain data; copy it without relying on browser-only structuredClone. */
export function captureCreationInput<T>(value: T): T;
export function captureCreationInput(value: unknown): unknown {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(captureCreationInput);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, captureCreationInput(item)]),
    );
  }
  return value;
}
