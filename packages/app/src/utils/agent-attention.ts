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
  let pendingFocus = false;

  function acknowledgeFocus() {
    if (!pendingFocus || !state?.focused || !state.ready) return;
    pendingFocus = false;
    if (!state.requiresAttention || state.attentionReason === "permission" || inFlight) return;
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
    focus() {
      if (!state?.focused) return;
      pendingFocus = true;
      acknowledgeFocus();
    },
    update(next: AttentionState) {
      const entered = next.focused && !state?.focused;
      const requested = next.focusRequest !== null && next.focusRequest !== state?.focusRequest;
      state = { ...next };
      if (!next.focused) pendingFocus = false;
      else if (entered || requested) pendingFocus = true;
      acknowledgeFocus();
    },
  };
}
