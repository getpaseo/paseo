import type { TerminalActivityState } from "@getpaseo/protocol/terminal-activity";

export interface TerminalActivitySnapshot {
  state: TerminalActivityState | null;
  changedAt: number;
}

export class TerminalActivityTracker {
  // unknown != idle: a plain shell, or a terminal whose agent was killed, has no dot or rollup.
  private resolvedState: TerminalActivityState | null = null;
  private changedAt = Date.now();

  private readonly changeListeners = new Set<
    (snapshot: TerminalActivitySnapshot, previous: TerminalActivitySnapshot) => void
  >();

  set(state: TerminalActivityState): void {
    this.setState(state);
  }

  clear(): void {
    this.setState(null);
  }

  clearAttention(): boolean {
    if (this.resolvedState !== "attention") {
      return false;
    }
    this.setState("idle");
    return true;
  }

  private setState(state: TerminalActivityState | null): void {
    if (state === this.resolvedState) {
      return;
    }

    const previous = this.getSnapshot();
    this.resolvedState = state;
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
      changedAt: this.changedAt,
    };
  }

  dispose(): void {
    this.changeListeners.clear();
  }
}
