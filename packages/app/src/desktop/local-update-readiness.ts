const guards = new Set<() => boolean>();
export function registerLocalUpdateGuard(isBlocked: () => boolean): () => void {
  guards.add(isBlocked);
  return () => {
    guards.delete(isBlocked);
  };
}
export function hasLocalUpdateBlockers(): boolean {
  return [...guards].some((isBlocked) => isBlocked());
}
