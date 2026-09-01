export interface TurnStartToken {
  readonly generation: number;
  readonly settled: Promise<void>;
  complete(): void;
}

export class TurnCancellationGate {
  private quiescence: Promise<void> = Promise.resolve();
  private failure: unknown = null;
  private closed = false;
  private generation = 0;
  private lastCancellationTarget: string | null | undefined;
  private readonly pendingStarts = new Set<TurnStartToken>();
  private readonly closeSignal: Promise<void>;
  private resolveCloseSignal!: () => void;

  constructor() {
    this.closeSignal = new Promise<void>((resolve) => {
      this.resolveCloseSignal = resolve;
    });
  }

  beginStart(): TurnStartToken {
    this.assertUsable();
    let settled = false;
    let resolveSettled!: () => void;
    const settledPromise = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const token: TurnStartToken = {
      generation: this.generation,
      settled: settledPromise,
      complete: () => {
        if (settled) return;
        settled = true;
        this.pendingStarts.delete(token);
        resolveSettled();
      },
    };
    this.pendingStarts.add(token);
    return token;
  }

  isCurrent(token: TurnStartToken): boolean {
    return !this.closed && this.failure === null && token.generation === this.generation;
  }

  assertCurrent(token: TurnStartToken): void {
    this.assertUsable();
    if (token.generation !== this.generation) {
      const error = new Error("Turn start was canceled before prompt dispatch");
      error.name = "TurnStartCanceledError";
      throw Object.assign(error, { code: "TURN_START_CANCELED" as const });
    }
  }

  async waitForQuiescence(exemptStart?: TurnStartToken): Promise<void> {
    while (true) {
      if (exemptStart) this.assertCurrent(exemptStart);
      else this.assertUsable();
      const observedQuiescence = this.quiescence;
      const observedPendingStarts = this.pendingStartPromises(exemptStart);
      const waits: Promise<void>[] = [observedQuiescence, this.closeSignal];
      if (observedPendingStarts.length > 0) {
        waits.push(Promise.all(observedPendingStarts).then(() => undefined));
      }
      await Promise.race(waits);
      if (exemptStart) this.assertCurrent(exemptStart);
      else this.assertUsable();
      if (
        observedQuiescence === this.quiescence &&
        this.pendingStartPromises(exemptStart).length === 0
      ) {
        return;
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.resolveCloseSignal();
    for (const start of this.pendingStarts) {
      start.complete();
    }
  }

  interrupt(
    expectedTurnId: string | undefined,
    getActiveTurnId: () => string | null,
    cancel: (turnId: string) => Promise<void>,
  ): Promise<void> {
    try {
      this.assertUsable();
    } catch (error) {
      return Promise.reject(error);
    }

    const observedTurnId = getActiveTurnId();
    const observedPendingStarts = [...this.pendingStarts];
    if (
      (!observedTurnId && observedPendingStarts.length === 0) ||
      (expectedTurnId !== undefined && observedTurnId !== expectedTurnId)
    ) {
      return Promise.resolve();
    }

    const invalidatesPendingStarts = this.lastCancellationTarget !== observedTurnId;
    this.lastCancellationTarget = observedTurnId;
    if (invalidatesPendingStarts) {
      this.generation += 1;
    }
    const cancellation = this.quiescence.then(async () => {
      this.assertUsable();
      const activeTurnId = getActiveTurnId();
      if (!activeTurnId || (expectedTurnId !== undefined && activeTurnId !== expectedTurnId)) {
        if (invalidatesPendingStarts) {
          await this.waitForPendingStarts(observedPendingStarts);
        }
        return;
      }
      await cancel(activeTurnId);
      if (invalidatesPendingStarts) {
        await this.waitForPendingStarts(observedPendingStarts);
      }
      return undefined;
    });
    this.quiescence = cancellation.then(
      () => undefined,
      (error) => {
        this.failure = error;
        throw error;
      },
    );
    void this.quiescence.catch(() => undefined);
    return cancellation;
  }

  private assertUsable(): void {
    if (this.closed) throw this.closedError();
    if (this.failure !== null) throw this.failure;
  }

  private pendingStartPromises(exemptStart?: TurnStartToken): Promise<void>[] {
    return [...this.pendingStarts]
      .filter((start) => start !== exemptStart)
      .map((start) => start.settled);
  }

  private async waitForPendingStarts(starts: TurnStartToken[]): Promise<void> {
    if (starts.length === 0) return;
    await Promise.race([Promise.all(starts.map((start) => start.settled)), this.closeSignal]);
    this.assertUsable();
  }

  private closedError(): Error & { code: "TURN_CANCELLATION_SESSION_CLOSED" } {
    const error = new Error("Turn cancellation session is closed");
    error.name = "TurnCancellationSessionClosedError";
    return Object.assign(error, { code: "TURN_CANCELLATION_SESSION_CLOSED" as const });
  }
}
