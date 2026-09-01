export class TurnCancellationGate {
  private quiescence: Promise<void> = Promise.resolve();
  private failure: unknown = null;
  private closed = false;
  private readonly closeSignal: Promise<void>;
  private resolveCloseSignal!: () => void;

  constructor() {
    this.closeSignal = new Promise<void>((resolve) => {
      this.resolveCloseSignal = resolve;
    });
  }

  async waitForQuiescence(): Promise<void> {
    while (true) {
      if (this.closed) throw this.closedError();
      if (this.failure !== null) throw this.failure;
      const observedQuiescence = this.quiescence;
      await Promise.race([observedQuiescence, this.closeSignal]);
      if (this.closed) throw this.closedError();
      if (this.failure !== null) throw this.failure;
      if (observedQuiescence === this.quiescence) return;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.resolveCloseSignal();
  }

  interrupt(
    expectedTurnId: string | undefined,
    getActiveTurnId: () => string | null,
    cancel: (turnId: string) => Promise<void>,
  ): Promise<void> {
    if (this.closed) return Promise.reject(this.closedError());
    if (this.failure !== null) return Promise.reject(this.failure);

    const observedTurnId = getActiveTurnId();
    if (!observedTurnId || (expectedTurnId !== undefined && observedTurnId !== expectedTurnId)) {
      return Promise.resolve();
    }

    const cancellation = this.quiescence.then(async () => {
      if (this.closed) throw this.closedError();
      const activeTurnId = getActiveTurnId();
      if (!activeTurnId || (expectedTurnId !== undefined && activeTurnId !== expectedTurnId)) {
        return undefined;
      }
      await cancel(activeTurnId);
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

  private closedError(): Error & { code: "TURN_CANCELLATION_SESSION_CLOSED" } {
    const error = new Error("Turn cancellation session is closed");
    error.name = "TurnCancellationSessionClosedError";
    return Object.assign(error, { code: "TURN_CANCELLATION_SESSION_CLOSED" as const });
  }
}
