interface AttentionState {
  focused: boolean;
  ready: boolean;
  requiresAttention: boolean;
  attentionReason: "finished" | "error" | "permission" | null | undefined;
  focusRequest: object | null;
}

export function createAgentAttentionController(deps: {
  clear: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  let state: AttentionState | null = null;
  let inFlight = false;

  function focus() {
    if (
      !state?.focused ||
      !state.ready ||
      !state.requiresAttention ||
      state.attentionReason === "permission" ||
      inFlight
    )
      return;
    inFlight = true;
    void deps.clear().then(
      () => {
        inFlight = false;
        return undefined;
      },
      (error: unknown) => {
        inFlight = false;
        deps.onError(error);
      },
    );
  }

  return {
    focus,
    update(next: AttentionState) {
      const entered = next.focused && next.ready && !(state?.focused && state.ready);
      const requested = next.focusRequest !== null && next.focusRequest !== state?.focusRequest;
      state = { ...next };
      if (entered || requested) focus();
    },
  };
}
