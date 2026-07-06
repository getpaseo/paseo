export interface TrailAnchorSnapshot {
  currentId: string | null;
}

export interface TrailAnchorStore {
  publish(next: TrailAnchorSnapshot): void;
  getSnapshot(): TrailAnchorSnapshot;
  subscribe(listener: (s: TrailAnchorSnapshot) => void): () => void;
}

const INITIAL_SNAPSHOT: TrailAnchorSnapshot = { currentId: null };

function isSameSnapshot(a: TrailAnchorSnapshot, b: TrailAnchorSnapshot): boolean {
  return a.currentId === b.currentId;
}

export function createTrailAnchorStore(): TrailAnchorStore {
  let snapshot: TrailAnchorSnapshot = INITIAL_SNAPSHOT;
  const listeners = new Set<(s: TrailAnchorSnapshot) => void>();

  return {
    publish(next) {
      if (isSameSnapshot(snapshot, next)) {
        return;
      }
      snapshot = next;
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
