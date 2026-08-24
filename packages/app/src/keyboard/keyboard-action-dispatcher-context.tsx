import { createContext, type ReactNode, useContext, useRef } from "react";

import { createKeyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher";

type KeyboardActionDispatcher = ReturnType<typeof createKeyboardActionDispatcher>;

const KeyboardActionDispatcherContext = createContext<KeyboardActionDispatcher | null>(null);

export function KeyboardActionDispatcherProvider({ children }: { children: ReactNode }) {
  const dispatcherRef = useRef<KeyboardActionDispatcher | null>(null);
  if (!dispatcherRef.current) {
    dispatcherRef.current = createKeyboardActionDispatcher();
  }

  return (
    <KeyboardActionDispatcherContext.Provider value={dispatcherRef.current}>
      {children}
    </KeyboardActionDispatcherContext.Provider>
  );
}

export function useKeyboardActionDispatcher(): KeyboardActionDispatcher {
  const dispatcher = useContext(KeyboardActionDispatcherContext);
  if (!dispatcher) {
    throw new Error("useKeyboardActionDispatcher must be used within its provider");
  }
  return dispatcher;
}
