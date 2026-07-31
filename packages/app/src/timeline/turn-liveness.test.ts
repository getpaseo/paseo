import { describe, expect, it } from "vitest";
import { reduceTurnLiveness, resolveTurnPresentation, TURN_LIVENESS_IDLE } from "./turn-liveness";

describe("reduceTurnLiveness", () => {
  it("closes a directory-seeded turn when a completed resume snapshot is idle", () => {
    const startedAt = new Date("2026-07-31T10:00:00.000Z");
    const opened = reduceTurnLiveness(TURN_LIVENESS_IDLE, {
      type: "directory_running",
      startedAt,
    });

    const resumed = reduceTurnLiveness(opened, {
      type: "resume_snapshot",
      status: "idle",
      startedAt,
      coverage: { epoch: "epoch-1", seq: 40 },
    });

    expect(resumed).toEqual(TURN_LIVENESS_IDLE);
  });

  it("does not let an older resume snapshot close a newer live turn", () => {
    const startedAt = new Date("2026-07-31T10:01:00.000Z");
    const liveTurn = reduceTurnLiveness(TURN_LIVENESS_IDLE, {
      type: "stream_open",
      startedAt,
      evidence: { epoch: "epoch-1", seq: 41 },
    });

    const resumed = reduceTurnLiveness(liveTurn, {
      type: "resume_snapshot",
      status: "idle",
      startedAt: null,
      coverage: { epoch: "epoch-1", seq: 40 },
    });

    expect(resumed).toEqual({
      phase: "open",
      startedAt,
      evidence: { epoch: "epoch-1", seq: 41 },
    });
  });

  it("uses submission evidence when the rendered tail does not contain the prompt", () => {
    const submittedAt = new Date("2026-07-31T10:02:00.000Z");

    expect(resolveTurnPresentation(TURN_LIVENESS_IDLE, [{ submittedAt }])).toEqual({
      isActive: true,
      startedAt: submittedAt,
    });
  });

  it("fills a missing directory start time from a running resume snapshot", () => {
    const snapshotStartedAt = new Date("2026-07-31T10:03:00.000Z");
    const opened = reduceTurnLiveness(TURN_LIVENESS_IDLE, {
      type: "directory_running",
      startedAt: null,
    });

    expect(
      reduceTurnLiveness(opened, {
        type: "resume_snapshot",
        status: "running",
        startedAt: snapshotStartedAt,
        coverage: { epoch: "epoch-1", seq: 40 },
      }),
    ).toEqual({
      phase: "open",
      startedAt: snapshotStartedAt,
      evidence: { epoch: "epoch-1", seq: 40 },
    });
  });

  it("does not downgrade newer live evidence from an older running snapshot", () => {
    const startedAt = new Date("2026-07-31T10:04:00.000Z");
    const liveTurn = reduceTurnLiveness(TURN_LIVENESS_IDLE, {
      type: "stream_open",
      startedAt,
      evidence: { epoch: "epoch-1", seq: 41 },
    });

    expect(
      reduceTurnLiveness(liveTurn, {
        type: "resume_snapshot",
        status: "running",
        startedAt,
        coverage: { epoch: "epoch-1", seq: 40 },
      }),
    ).toBe(liveTurn);
  });

  it("starts a new clock when consecutive turns settle in one stream batch", () => {
    const firstStartedAt = new Date("2026-07-31T10:05:00.000Z");
    const secondStartedAt = new Date("2026-07-31T10:06:00.000Z");
    const firstTurn = reduceTurnLiveness(TURN_LIVENESS_IDLE, {
      type: "stream_open",
      startedAt: firstStartedAt,
      evidence: { epoch: "epoch-1", seq: 41 },
    });

    expect(
      reduceTurnLiveness(firstTurn, {
        type: "stream_restart",
        startedAt: secondStartedAt,
        evidence: { epoch: "epoch-1", seq: 43 },
      }),
    ).toEqual({
      phase: "open",
      startedAt: secondStartedAt,
      evidence: { epoch: "epoch-1", seq: 43 },
    });
  });
});
