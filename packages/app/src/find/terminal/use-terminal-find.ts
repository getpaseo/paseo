import type { RefObject } from "react";
import type { TerminalEmulatorHandle } from "@/components/terminal-emulator-contract";
import { EMPTY_FIND_RESULT } from "@/find/model";
import type { UseFindSurfaceResult } from "@/find/use-find-surface";
import type { TerminalFindResults } from "@/terminal/runtime/terminal-emulator-runtime";

export interface UseTerminalFindInput {
  enabled: boolean;
  engineKey: string | null;
  emulatorRef: RefObject<TerminalEmulatorHandle | null>;
  getRoot: () => HTMLElement | null;
}

export interface UseTerminalFindResult {
  find: UseFindSurfaceResult;
  onFindResultsChange: (results: TerminalFindResults) => void;
  onFindBufferChange: () => void;
}

const noop = () => {};

const INERT_FIND: UseFindSurfaceResult = {
  isOpen: false,
  query: "",
  result: EMPTY_FIND_RESULT,
  open: noop,
  close: noop,
  setQuery: noop,
  next: noop,
  previous: noop,
  inputRef: { current: null },
};

const INERT_RESULT: UseTerminalFindResult = {
  find: INERT_FIND,
  onFindResultsChange: noop,
  onFindBufferChange: noop,
};

/**
 * Find is web-only (keyboard/availability.ts), so the native build gets a bar that can
 * never open. See use-terminal-find.web.ts for the real implementation.
 */
export function useTerminalFind(_input: UseTerminalFindInput): UseTerminalFindResult {
  return INERT_RESULT;
}
