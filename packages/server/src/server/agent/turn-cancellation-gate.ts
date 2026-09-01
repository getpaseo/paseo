export class TurnCancellationGate {
  private quiescence: Promise<void> = Promise.resolve();

  waitForQuiescence(): Promise<void> {
    return this.quiescence;
  }

  interrupt(
    expectedTurnId: string | undefined,
    getActiveTurnId: () => string | null,
    cancel: (turnId: string) => Promise<void>,
  ): Promise<void> {
    const observedTurnId = getActiveTurnId();
    if (!observedTurnId || (expectedTurnId !== undefined && observedTurnId !== expectedTurnId)) {
      return Promise.resolve();
    }

    const cancellation = this.quiescence.then(async () => {
      const activeTurnId = getActiveTurnId();
      if (!activeTurnId || (expectedTurnId !== undefined && activeTurnId !== expectedTurnId)) {
        return undefined;
      }
      await cancel(activeTurnId);
      return undefined;
    });
    this.quiescence = cancellation.then(
      () => undefined,
      () => undefined,
    );
    return cancellation;
  }
}
