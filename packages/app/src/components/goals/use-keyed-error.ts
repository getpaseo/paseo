import { useCallback, useState } from "react";

/**
 * An error that belongs to one state of what it is about, such as one revision or one status of a
 * recovery. Once `key` changes the old error no longer shows, and a request that fails after the
 * state moved on does not show its error under the new state either.
 */
export function useKeyedError(key: string): [string | null, (message: string | null) => void] {
  const [state, setState] = useState<{ key: string; message: string } | null>(null);
  const setError = useCallback(
    (message: string | null) => setState(message ? { key, message } : null),
    [key],
  );
  return [state?.key === key ? state.message : null, setError];
}
