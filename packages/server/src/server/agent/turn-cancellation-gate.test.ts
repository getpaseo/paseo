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
});
