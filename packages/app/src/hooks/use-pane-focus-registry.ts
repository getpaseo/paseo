import { useCallback, useRef } from "react";

export type PaneFocusRegistry = {
  register(tabId: string, callback: () => void): () => void;
  focusTab(tabId: string): void;
};

export function usePaneFocusRegistry(): PaneFocusRegistry {
  const callbacksRef = useRef(new Map<string, () => void>());

  const register = useCallback((tabId: string, callback: () => void): (() => void) => {
    callbacksRef.current.set(tabId, callback);
    return () => {
      if (callbacksRef.current.get(tabId) === callback) {
        callbacksRef.current.delete(tabId);
      }
    };
  }, []);

  const focusTab = useCallback((tabId: string) => {
    callbacksRef.current.get(tabId)?.();
  }, []);

  return useRef({ register, focusTab }).current;
}
