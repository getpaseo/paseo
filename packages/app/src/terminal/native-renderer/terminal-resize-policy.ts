export interface TerminalSize {
  rows: number;
  cols: number;
}

export type TerminalResizeSource = "measure" | "claim";

export interface TerminalResizePolicyState {
  measuredSize: TerminalSize;
  claimedSize: TerminalSize | null;
  lastClaimToken: number | null;
  pendingClaim: boolean;
  pendingForceClaim: boolean;
}

export interface TerminalResizeClaim extends TerminalSize {
  force: boolean;
}

export interface TerminalResizePolicyInput {
  source: TerminalResizeSource;
  size: TerminalSize | null;
  claimToken?: number;
}

export interface TerminalResizePolicyResult {
  state: TerminalResizePolicyState;
  measuredSize: TerminalSize;
  resizeClaim: TerminalResizeClaim | null;
  measuredSizeChanged: boolean;
}

export function createTerminalResizePolicy(initialSize: TerminalSize): TerminalResizePolicyState {
  return {
    measuredSize: initialSize,
    claimedSize: null,
    lastClaimToken: null,
    pendingClaim: false,
    pendingForceClaim: false,
  };
}

export function updateTerminalResizePolicy(
  state: TerminalResizePolicyState,
  input: TerminalResizePolicyInput,
): TerminalResizePolicyResult {
  if (!input.size) {
    const claimRequested = isNewClaim(state, input);
    const nextState = {
      ...state,
      lastClaimToken: nextClaimToken(state, input),
      pendingClaim: state.pendingClaim || claimRequested,
      pendingForceClaim: state.pendingForceClaim || hasNewClaimToken(state, input),
    };

    return {
      state: nextState,
      measuredSize: nextState.measuredSize,
      resizeClaim: null,
      measuredSizeChanged: false,
    };
  }

  const measuredSizeChanged = !terminalSizesEqual(state.measuredSize, input.size);
  const claimToken = nextClaimToken(state, input);
  const forceReclaim = state.pendingForceClaim || hasNewClaimToken(state, input);
  const shouldClaim = state.pendingClaim || isNewClaim(state, input);
  const resizeClaim = shouldClaim ? { ...input.size, force: forceReclaim } : null;
  const claimedSize = resizeClaim ? input.size : state.claimedSize;
  const nextState = {
    measuredSize: input.size,
    claimedSize,
    lastClaimToken: claimToken,
    pendingClaim: shouldClaim ? false : state.pendingClaim,
    pendingForceClaim: shouldClaim ? false : state.pendingForceClaim,
  };

  return {
    state: nextState,
    measuredSize: input.size,
    resizeClaim,
    measuredSizeChanged,
  };
}

function terminalSizesEqual(left: TerminalSize | null, right: TerminalSize): boolean {
  return left !== null && left.rows === right.rows && left.cols === right.cols;
}

function nextClaimToken(
  state: TerminalResizePolicyState,
  input: TerminalResizePolicyInput,
): number | null {
  if (input.source !== "claim") {
    return state.lastClaimToken;
  }
  return input.claimToken ?? state.lastClaimToken;
}

function hasNewClaimToken(
  state: TerminalResizePolicyState,
  input: TerminalResizePolicyInput,
): boolean {
  if (input.source !== "claim") {
    return false;
  }
  const claimToken = nextClaimToken(state, input);
  return claimToken !== state.lastClaimToken;
}

function isNewClaim(state: TerminalResizePolicyState, input: TerminalResizePolicyInput): boolean {
  if (input.source !== "claim") {
    return false;
  }
  if (input.claimToken !== undefined) {
    return hasNewClaimToken(state, input);
  }
  return input.size === null || !terminalSizesEqual(state.claimedSize, input.size);
}
