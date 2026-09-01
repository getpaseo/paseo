export interface TurnStartToken {
  readonly generation: number;
  readonly settled: Promise<void>;
  readonly barrier: Promise<void>;
  complete(): void;
}

type CancellationTarget = { kind: "turn"; turnId: string } | { kind: "start"; generation: number };

export class TurnStartCanceledError extends Error {
  readonly code = "TURN_START_CANCELED" as const;

  constructor() {
    super("Turn start was canceled before prompt dispatch");
    this.name = "TurnStartCanceledError";
  }
}

function sameCancellationTarget(
  left: CancellationTarget | null,
  right: CancellationTarget,
): boolean {
  if (!left || left.kind !== right.kind) return false;
  if (left.kind === "turn" && right.kind === "turn") {
    return left.turnId === right.turnId;
  }
  if (left.kind === "start" && right.kind === "start") {
    return left.generation === right.generation;
  }
  return false;
}

export class TurnCancellationGate {
  private quiescence: Promise<void> = Promise.resolve();
  private startBarrier: Promise<void> = Promise.resolve();
  private failure: unknown = null;
  private closed = false;
  private generation = 0;
  private lastCancellationTarget: CancellationTarget | null = null;
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
    const barrier = Promise.all([this.quiescence, this.startBarrier]).then(() => undefined);
    let settled = false;
    let resolveSettled!: () => void;
    const settledPromise = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const token: TurnStartToken = {
      generation: this.generation,
      settled: settledPromise,
      barrier,
      complete: () => {
        if (settled) return;
        settled = true;
        this.pendingStarts.delete(token);
        resolveSettled();
      },
    };
    this.pendingStarts.add(token);
    this.startBarrier = Promise.all([this.startBarrier, settledPromise]).then(() => undefined);
    return token;
  }

  isCurrent(token: TurnStartToken): boolean {
    return !this.closed && this.failure === null && token.generation === this.generation;
  }

  assertCurrent(token: TurnStartToken): void {
    this.assertUsable();
    if (token.generation !== this.generation) {
      throw new TurnStartCanceledError();
    }
  }

  async waitForQuiescence(exemptStart?: TurnStartToken): Promise<void> {
    const barrier = exemptStart?.barrier ?? Promise.all([this.quiescence, this.startBarrier]);
    await Promise.race([barrier, this.closeSignal]);
    if (exemptStart) this.assertCurrent(exemptStart);
    else this.assertUsable();
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

    const target: CancellationTarget = observedTurnId
      ? { kind: "turn", turnId: observedTurnId }
      : {
          kind: "start",
          // The oldest still-pending start is the target that established this cancellation
          // boundary. A repeated interrupt must not advance the generation again and cancel a
          // successor admitted after that boundary.
          generation: observedPendingStarts[0]?.generation ?? this.generation,
        };
    const invalidatesPendingStarts = !sameCancellationTarget(this.lastCancellationTarget, target);
    this.lastCancellationTarget = target;
    if (invalidatesPendingStarts) {
      this.generation += 1;
    }
    const cancellation = this.quiescence.then(async () => {
      this.assertUsable();
      const activeTurnId = getActiveTurnId();
      if (
        !activeTurnId ||
        (expectedTurnId !== undefined && activeTurnId !== expectedTurnId) ||
        (observedTurnId !== null && activeTurnId !== observedTurnId)
      ) {
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
