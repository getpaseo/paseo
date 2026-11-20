interface PresenceSource {
  read(): boolean;
  watch(changed: () => void): () => void;
}
export function createHardwareKeyboardPresence(source: PresenceSource) {
  let present = source.read();
  const listeners = new Set<() => void>();
  let stop: (() => void) | undefined;
  const update = () => {
    const next = source.read();
    if (present === next) return;
    present = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => present,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        stop = source.watch(update);
        update();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stop?.();
          stop = undefined;
        }
      };
    },
  };
}
