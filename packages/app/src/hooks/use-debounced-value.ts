import { useEffect, useState } from "react";

/**
 * Trails `value` by `delayMs`, so a value that drives a request settles before
 * it is sent. The current value stays the caller's — this only decides when the
 * expensive consumer gets to see it.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
