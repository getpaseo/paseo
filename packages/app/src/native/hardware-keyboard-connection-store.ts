export interface HardwareKeyboardConnectionPort {
  isConnected(): boolean;
  addListener(handler: (connected: boolean) => void): void;
}

export interface HardwareKeyboardConnectionStore {
  subscribe(onChange: () => void): () => void;
  getSnapshot(): boolean;
}

export function createHardwareKeyboardConnectionStore(
  port: HardwareKeyboardConnectionPort,
): HardwareKeyboardConnectionStore {
  // why: the listener is registered before the first read, so a change in between is not lost.
  let connected = false;
  const listeners = new Set<() => void>();
  port.addListener((next) => {
    if (next === connected) return;
    connected = next;
    listeners.forEach((listener) => listener());
  });
  connected = port.isConnected();

  return {
    subscribe(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    // why: render reads the cached value so getSnapshot never crosses the native bridge per render.
    getSnapshot() {
      return connected;
    },
  };
}
