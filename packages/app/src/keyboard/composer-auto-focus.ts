import { create } from "zustand";

// Set when a hardware-keyboard shortcut should land focus in the composer
// (workspace navigation, or a focus action no mounted composer handled).
// Consumed by the composer that becomes active so typing can continue without
// touching the screen. Time-boxed so a missed consume can't focus an input
// long after the fact.
const VALIDITY_MS = 3000;

let requestedAt: number | null = null;

interface ComposerAutoFocusState {
  version: number;
}

const useComposerAutoFocusStore = create<ComposerAutoFocusState>(() => ({ version: 0 }));

export function requestComposerAutoFocus(): void {
  requestedAt = Date.now();
  useComposerAutoFocusStore.setState((state) => ({ version: state.version + 1 }));
}

export function consumeComposerAutoFocus(): boolean {
  if (requestedAt === null) return false;
  const valid = Date.now() - requestedAt <= VALIDITY_MS;
  requestedAt = null;
  return valid;
}

/** Re-renders consumers when a new auto-focus request lands. */
export function useComposerAutoFocusVersion(): number {
  return useComposerAutoFocusStore((state) => state.version);
}
