interface AttentionState {
  focused: boolean;
  ready: boolean;
  requiresAttention: boolean;
  attentionKey: string | null;
  attentionReason: "finished" | "error" | "permission" | null | undefined;
  focusRequest: object | null;
}

export function createAgentAttentionController(deps: {
  clear: (attentionKey: string | null) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  let state: AttentionState | null = null;
  const inFlight = new Set<string | null>();
  let pendingFocus = false;

  function acknowledgeFocus() {
    if (!pendingFocus || !state?.focused || !state.ready) return;
    pendingFocus = false;
    if (
      !state.requiresAttention ||
      state.attentionReason === "permission" ||
      inFlight.has(state.attentionKey)
    )
      return;
    const key = state.attentionKey;
    inFlight.add(key);
    void deps.clear(key).then(
      () => {
        inFlight.delete(key);
        return undefined;
      },
      (error: unknown) => {
        inFlight.delete(key);
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
