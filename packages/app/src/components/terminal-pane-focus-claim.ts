export interface FocusClaimState {
  claimedKey: string | null;
  requestedKey: string | null;
}

export interface FocusClaimStep {
  state: FocusClaimState;
  shouldRequest: boolean;
}

export interface FocusClaimReadiness {
  isWorkspaceFocused: boolean;
  isPaneFocused: boolean;
  isAppActivelyVisible: boolean;
  isClientReady: boolean;
  isConnected: boolean;
  isRendererReady: boolean;
}

interface TerminalSize {
  rows: number;
  cols: number;
}

export function resolveTerminalResizeClaim(input: {
  size: TerminalSize;
  previousSentSize: TerminalSize | null;
  shouldClaim: boolean;
  forceClaim: boolean;
  readiness: FocusClaimReadiness;
}): { shouldSend: boolean } {
  if (!input.shouldClaim || !canRequestFocusClaim(input.readiness)) {
    return { shouldSend: false };
  }
  return {
    shouldSend:
      input.forceClaim ||
      input.previousSentSize === null ||
      input.previousSentSize.rows !== input.size.rows ||
      input.previousSentSize.cols !== input.size.cols,
  };
}

export const EMPTY_FOCUS_CLAIM_STATE: FocusClaimState = {
  claimedKey: null,
  requestedKey: null,
};

export function canRequestFocusClaim(input: FocusClaimReadiness): boolean {
  return (
    input.isWorkspaceFocused &&
    input.isPaneFocused &&
    input.isAppActivelyVisible &&
    input.isClientReady &&
    input.isConnected &&
    input.isRendererReady
  );
}

export function reconcileFocusClaim(
  state: FocusClaimState,
  input: { key: string | null; canRequest: boolean },
): FocusClaimStep {
  if (input.key === null) {
    return { state: EMPTY_FOCUS_CLAIM_STATE, shouldRequest: false };
  }
  if (state.claimedKey === input.key) {
    return {
      state: { claimedKey: input.key, requestedKey: null },
      shouldRequest: false,
    };
  }
  if (!input.canRequest) {
    return {
      state: { claimedKey: state.claimedKey, requestedKey: null },
      shouldRequest: false,
    };
  }
  if (state.requestedKey === input.key) {
    return { state, shouldRequest: false };
  }
  return {
    state: { claimedKey: state.claimedKey, requestedKey: input.key },
    shouldRequest: true,
  };
}

export function settleFocusClaim(
  state: FocusClaimState,
  input: { key: string; sent: boolean },
): FocusClaimState {
  if (state.requestedKey !== input.key) {
    return state;
  }
  return {
    claimedKey: input.sent ? input.key : state.claimedKey,
    requestedKey: null,
  };
}
