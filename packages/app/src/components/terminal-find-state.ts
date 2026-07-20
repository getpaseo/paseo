import type { PaneFindState } from "@/pane-find/pane-find-types";

export type TerminalFindAction =
  | { type: "open" }
  | { type: "reset" }
  | { type: "query"; query: string }
  | { type: "result"; matchCount: number; selectedIndex: number };

export const INITIAL_TERMINAL_FIND_STATE: PaneFindState = {
  isOpen: false,
  query: "",
  isPending: false,
  matchCount: 0,
  selectedIndex: -1,
};

/** Keeps terminal find UI state independent from xterm's asynchronous search results. */
export function reduceTerminalFindState(
  state: PaneFindState,
  action: TerminalFindAction,
): PaneFindState {
  if (action.type === "open") return { ...state, isOpen: true };
  if (action.type === "reset") return INITIAL_TERMINAL_FIND_STATE;
  if (action.type === "query") {
    return {
      ...state,
      query: action.query,
      isPending: action.query.length > 0,
      matchCount: 0,
      selectedIndex: -1,
    };
  }
  return {
    ...state,
    isPending: false,
    matchCount: action.matchCount,
    selectedIndex: action.selectedIndex,
  };
}
