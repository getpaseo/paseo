import { describe, expect, test } from "vitest";
import { TurnCancellationGate } from "./turn-cancellation-gate.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("TurnCancellationGate", () => {
  test("invalidates a captured start generation as soon as cancellation begins", async () => {
    const gate = new TurnCancellationGate();
    const start = gate.beginStart();
    const cancellation = gate.interrupt(
      undefined,
      () => null,
      async () => undefined,
    );

    expect(() => gate.assertCurrent(start)).toThrow(/canceled/i);

    start.complete();
    await cancellation;
  });

  test("waits for a pending startup to settle before acknowledging its cancellation", async () => {
    const gate = new TurnCancellationGate();
    const start = gate.beginStart();
    let cancellationSettled = false;
    const cancellation = gate
      .interrupt(
        undefined,
        () => null,
        async () => undefined,
      )
      .then(() => {
        cancellationSettled = true;
        return undefined;
      });

    await Promise.resolve();
    expect(cancellationSettled).toBe(false);

    start.complete();
    await cancellation;
    expect(cancellationSettled).toBe(true);
  });

  test("does not let a successor start while an earlier startup is pending", async () => {
    const gate = new TurnCancellationGate();
    const first = gate.beginStart();
    const second = gate.beginStart();
    let successorReady = false;
    const successor = gate.waitForQuiescence(second).then(() => {
      successorReady = true;
      return undefined;
    });

    await Promise.resolve();
    expect(successorReady).toBe(false);

    first.complete();
    await successor;
    expect(successorReady).toBe(true);
    second.complete();
  });

  test("allows concurrent starts to wait only on starts admitted before them", async () => {
    const gate = new TurnCancellationGate();
    const first = gate.beginStart();
    const second = gate.beginStart();
    let firstReady = false;
    let secondReady = false;

    const firstWait = gate.waitForQuiescence(first).then(() => {
      firstReady = true;
      return undefined;
    });
    const secondWait = gate.waitForQuiescence(second).then(() => {
      secondReady = true;
      return undefined;
    });

    await firstWait;
    expect(firstReady).toBe(true);
    expect(secondReady).toBe(false);

    first.complete();
    await secondWait;
    expect(secondReady).toBe(true);
    await firstWait;
    second.complete();
  });

  test("keeps interleaved starts acyclic while a prior cancellation is settling", async () => {
    const gate = new TurnCancellationGate();
    const releaseCancellation = deferred();
    const cancellation = gate.interrupt(
      "turn-a",
      () => "turn-a",
      async () => releaseCancellation.promise,
    );
    const first = gate.beginStart();
    const second = gate.beginStart();
    let firstReady = false;
    let secondReady = false;
    const firstWait = gate.waitForQuiescence(first).then(() => {
      firstReady = true;
      return undefined;
    });
    const secondWait = gate.waitForQuiescence(second).then(() => {
      secondReady = true;
      return undefined;
    });

    releaseCancellation.resolve();
    await cancellation;
    await firstWait;
    expect(firstReady).toBe(true);
    expect(secondReady).toBe(false);

    first.complete();
    await secondWait;
    expect(secondReady).toBe(true);
    second.complete();
  });

  test("does not let an older cancellation target a start from its newer generation", async () => {
    const gate = new TurnCancellationGate();
    const first = gate.beginStart();
    const second = gate.beginStart();
    let activeTurnId: string | null = "turn-a";
    const canceledTurnIds: string[] = [];

    const cancellation = gate.interrupt(
      "turn-a",
      () => activeTurnId,
      async (turnId) => {
        canceledTurnIds.push(turnId);
      },
    );
    const newer = gate.beginStart();
    const newerWait = gate.waitForQuiescence(newer);
    activeTurnId = "turn-b";

    first.complete();
    second.complete();
    await cancellation;
    await newerWait;

    expect(canceledTurnIds).toEqual([]);
    expect(gate.isCurrent(newer)).toBe(true);
    newer.complete();
  });

  test("does not let a repeated cancellation fence a successor start", async () => {
    const gate = new TurnCancellationGate();
    const first = gate.beginStart();
    const firstCancellation = gate.interrupt(
      undefined,
      () => null,
      async () => undefined,
    );
    const successor = gate.beginStart();
    const repeatedCancellation = gate.interrupt(
      undefined,
      () => null,
      async () => undefined,
    );

    expect(gate.isCurrent(successor)).toBe(true);
    first.complete();
    await firstCancellation;
    await repeatedCancellation;
    await gate.waitForQuiescence(successor);
    successor.complete();
  });

  test("close releases pending start bookkeeping and rejects its cancellation", async () => {
    const gate = new TurnCancellationGate();
    const start = gate.beginStart();
    const cancellation = gate.interrupt(
      undefined,
      () => null,
      async () => undefined,
    );

    gate.close();
    gate.close();
    start.complete();

    await expect(cancellation).rejects.toMatchObject({ code: "TURN_CANCELLATION_SESSION_CLOSED" });
  });

  test("keeps a late cancellation from running after a newer turn starts", async () => {
    const gate = new TurnCancellationGate();
    let activeTurnId: string | null = "turn-a";
    const allowCancellation = deferred();
    const canceledTurnIds: string[] = [];

    const cancellation = gate.interrupt(
      "turn-a",
      () => activeTurnId,
      async (turnId) => {
        await allowCancellation.promise;
        canceledTurnIds.push(turnId);
      },
    );

    await Promise.resolve();
    activeTurnId = null;
    const startB = gate.waitForQuiescence().then(() => {
      activeTurnId = "turn-b";
      return undefined;
    });

    expect(canceledTurnIds).toEqual([]);
    allowCancellation.resolve();
    await cancellation;
    await startB;

    expect(canceledTurnIds).toEqual(["turn-a"]);
    expect(activeTurnId).toBe("turn-b");
  });

  test("does not signal a newer turn for a stale expected identity", async () => {
    const gate = new TurnCancellationGate();
    let activeTurnId: string | null = "turn-b";
    const canceledTurnIds: string[] = [];

    await gate.interrupt(
      "turn-a",
      () => activeTurnId,
      async (turnId) => {
        canceledTurnIds.push(turnId);
      },
    );

    expect(canceledTurnIds).toEqual([]);
  });

  test("poisons the gate after cancellation fails", async () => {
    const gate = new TurnCancellationGate();
    const failure = new Error("native interrupt failed");

    await expect(
      gate.interrupt(
        "turn-a",
        () => "turn-a",
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);

    await expect(gate.waitForQuiescence()).rejects.toBe(failure);
  });

  test("close unblocks a start waiting behind a hung cancellation and is idempotent", async () => {
    const gate = new TurnCancellationGate();
    const cancellation = gate.interrupt(
      "turn-a",
      () => "turn-a",
      async () => {
        await new Promise<void>(() => {});
      },
    );
    const start = gate.waitForQuiescence();

    (gate as TurnCancellationGate & { close: () => void }).close();
    (gate as TurnCancellationGate & { close: () => void }).close();

    await expect(start).rejects.toMatchObject({ code: "TURN_CANCELLATION_SESSION_CLOSED" });
    expect(cancellation).toBeInstanceOf(Promise);
  });
});
