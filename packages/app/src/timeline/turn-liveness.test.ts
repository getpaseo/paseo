import { describe, expect, it } from "vitest";
import { reduceTurnLiveness, resolveTurnPresentation, TURN_LIVENESS_IDLE } from "./turn-liveness";

describe("turn activity", () => {
  const startedAt = new Date("2026-07-31T10:00:00.000Z");

  it("ignores a terminal event for another turn", () => {
    const open = reduceTurnLiveness(TURN_LIVENESS_IDLE, {
      type: "stream_open",
      turn: { turnId: "turn-2", startedAt },
    });

    expect(reduceTurnLiveness(open, { type: "stream_close", turnId: "turn-1" })).toBe(open);
  });

  it("replaces activity from an authoritative snapshot", () => {
    const open = reduceTurnLiveness(TURN_LIVENESS_IDLE, {
      type: "stream_open",
      turn: { turnId: "turn-1", startedAt },
    });

    expect(reduceTurnLiveness(open, { type: "snapshot", activeTurn: null })).toEqual(
      TURN_LIVENESS_IDLE,
    );
  });

  it("opens an autonomous turn from an authoritative snapshot", () => {
    expect(
      reduceTurnLiveness(TURN_LIVENESS_IDLE, {
        type: "snapshot",
        activeTurn: { turnId: "autonomous-turn-1", startedAt },
      }),
    ).toEqual({
      phase: "open",
      turnId: "autonomous-turn-1",
      startedAt,
      cancellationRequestId: null,
    });
  });

  it("does not let an old cancel completion clear the current request", () => {
    const first = reduceTurnLiveness(TURN_LIVENESS_IDLE, {
      type: "cancellation_started",
      requestId: 1,
    });
    const second = reduceTurnLiveness(first, { type: "cancellation_started", requestId: 2 });

    expect(reduceTurnLiveness(second, { type: "cancellation_settled", requestId: 1 })).toBe(second);
  });

  it("keeps cancellation pending across submission-to-turn handoff", () => {
    const canceling = reduceTurnLiveness(TURN_LIVENESS_IDLE, {
      type: "cancellation_started",
      requestId: 1,
    });

    expect(
      reduceTurnLiveness(canceling, {
        type: "stream_open",
        turn: { turnId: "turn-1", startedAt },
      }),
    ).toEqual({
      phase: "open",
      turnId: "turn-1",
      startedAt,
      cancellationRequestId: 1,
    });
  });

  it("keeps submission-only activity untimed", () => {
    expect(
      resolveTurnPresentation(TURN_LIVENESS_IDLE, [
        { clientMessageId: "message-1", submittedAt: startedAt },
      ]),
    ).toEqual({
      isActive: true,
      isCancelling: false,
      startedAt: null,
      turnId: null,
    });
  });
});
