import type {
  TerminalActivityAttentionReason,
  TerminalActivityState,
} from "@getpaseo/protocol/terminal-activity";

export interface TerminalActivitySnapshot {
  state: TerminalActivityState | null;
  attentionReason: TerminalActivityAttentionReason | null;
  changedAt: number;
}

export class TerminalActivityTracker {
  // unknown != idle: a plain shell, or a terminal whose agent was killed, has no dot or rollup.
  private resolvedState: TerminalActivityState | null = null;
  private attentionReason: TerminalActivityAttentionReason | null = null;
  private changedAt = Date.now();

  private readonly changeListeners = new Set<
    (snapshot: TerminalActivitySnapshot, previous: TerminalActivitySnapshot) => void
  >();

  set(state: TerminalActivityState): void {
    if (state === "idle" && this.resolvedState === "working") {
      this.setState("idle", "finished");
      return;
    }

    if (state === "idle" && this.attentionReason === "finished") {
      return;
    }

    this.setState(
      state === "attention" ? "idle" : state,
      state === "attention" ? "needs_input" : null,
    );
  }

  // OSC 7501 idle: at rest. It never records finished attention, so an
  // interrupted run does not look finished, but it keeps a finished mark the
  // user has not seen yet (a program may report done, then idle).
  setAtRest(): void {
    if (this.attentionReason === "finished") {
      return;
    }
    this.setState("idle", null);
  }

  // OSC 7501 done or error: a result to review.
  finish(): void {
    this.setState("idle", "finished");
  }

  clear(): void {
    this.setState(null, null);
  }

  clearAttention(): boolean {
    if (!this.attentionReason) {
      return false;
    }
    this.setState("idle", null);
    return true;
  }

  interrupt(): void {
    if (this.resolvedState !== "working") {
      return;
    }
    this.setState(null, null);
  }

  private setState(
    state: TerminalActivityState | null,
    attentionReason: TerminalActivityAttentionReason | null,
  ): void {
    if (state === this.resolvedState && attentionReason === this.attentionReason) {
      return;
    }

    const previous = this.getSnapshot();
    this.resolvedState = state;
    this.attentionReason = attentionReason;
    this.changedAt = Date.now();

    const snapshot = this.getSnapshot();
    for (const listener of Array.from(this.changeListeners)) {
      listener(snapshot, previous);
    }
  }

  onChange(
    listener: (snapshot: TerminalActivitySnapshot, previous: TerminalActivitySnapshot) => void,
  ): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  getSnapshot(): TerminalActivitySnapshot {
    return {
      state: this.resolvedState,
      attentionReason: this.attentionReason,
      changedAt: this.changedAt,
    };
  }

  dispose(): void {
    this.changeListeners.clear();
  }
}
