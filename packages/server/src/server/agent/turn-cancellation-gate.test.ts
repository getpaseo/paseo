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
