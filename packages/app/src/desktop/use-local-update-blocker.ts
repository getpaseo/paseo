import { useEffect } from "react";

const blockers = new Set<symbol>();
export function hasLocalUpdateBlockers(): boolean {
  return blockers.size > 0;
}
export function useLocalUpdateBlocker(blocked: boolean): void {
  useEffect(() => {
    if (!blocked) return;
    const key = Symbol();
    blockers.add(key);
    return () => {
      blockers.delete(key);
    };
  }, [blocked]);
}
