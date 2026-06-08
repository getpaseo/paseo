import { describe, expect, test } from "vitest";
import {
  shouldEmitPendingBootstrapUpdate,
  type BootstrapUpdateSnapshot,
} from "./workspace-bootstrap-dedupe.js";

const SNAPSHOT_DONE_10_30: BootstrapUpdateSnapshot = {
  status: "done",
  statusEnteredAt: "2026-05-12T10:30:00.000Z",
  activityAtMs: Date.parse("2026-05-12T10:00:00.000Z"),
};

describe("shouldEmitPendingBootstrapUpdate", () => {
  test("emits when there is no snapshot (first-time subscription)", () => {
    expect(
      shouldEmitPendingBootstrapUpdate({
        snapshot: null,
        update: { status: "done", statusEnteredAt: null, activityAtMs: null },
      }),
    ).toBe(true);
  });

  test("emits when status changed (unmask case: needs_input → done)", () => {
    expect(
      shouldEmitPendingBootstrapUpdate({
        snapshot: { ...SNAPSHOT_DONE_10_30, status: "needs_input" },
        update: {
          status: "done",
          statusEnteredAt: SNAPSHOT_DONE_10_30.statusEnteredAt,
          activityAtMs: null,
        },
      }),
    ).toBe(true);
  });

  test("emits when statusEnteredAt changed (fresh unmask time)", () => {
    expect(
      shouldEmitPendingBootstrapUpdate({
        snapshot: SNAPSHOT_DONE_10_30,
        update: {
          status: "done",
          statusEnteredAt: "2026-05-12T11:00:00.000Z",
          activityAtMs: SNAPSHOT_DONE_10_30.activityAtMs,
        },
      }),
    ).toBe(true);
  });

  test("emits when statusEnteredAt transitions from null to a value (unmask)", () => {
    expect(
      shouldEmitPendingBootstrapUpdate({
        snapshot: { ...SNAPSHOT_DONE_10_30, statusEnteredAt: null },
        update: { ...SNAPSHOT_DONE_10_30 },
      }),
    ).toBe(true);
  });

  test("emits when statusEnteredAt transitions from value to null", () => {
    expect(
      shouldEmitPendingBootstrapUpdate({
        snapshot: SNAPSHOT_DONE_10_30,
        update: { ...SNAPSHOT_DONE_10_30, statusEnteredAt: null },
      }),
    ).toBe(true);
  });

  test("emits when update activity is strictly newer than snapshot activity", () => {
    expect(
      shouldEmitPendingBootstrapUpdate({
        snapshot: SNAPSHOT_DONE_10_30,
        update: {
          status: "done",
          statusEnteredAt: SNAPSHOT_DONE_10_30.statusEnteredAt,
          activityAtMs: Date.parse("2026-05-12T10:30:00.000Z"),
        },
      }),
    ).toBe(true);
  });

  test("emits when snapshot has no activity and update does (new activity)", () => {
    expect(
      shouldEmitPendingBootstrapUpdate({
        snapshot: { ...SNAPSHOT_DONE_10_30, activityAtMs: null },
        update: { ...SNAPSHOT_DONE_10_30 },
      }),
    ).toBe(true);
  });

  test("drops when status pair matches and update activity is older", () => {
    expect(
      shouldEmitPendingBootstrapUpdate({
        snapshot: SNAPSHOT_DONE_10_30,
        update: {
          status: "done",
          statusEnteredAt: SNAPSHOT_DONE_10_30.statusEnteredAt,
          activityAtMs: Date.parse("2026-05-12T09:30:00.000Z"),
        },
      }),
    ).toBe(false);
  });

  test("drops when status pair matches and activity is equal", () => {
    expect(
      shouldEmitPendingBootstrapUpdate({
        snapshot: SNAPSHOT_DONE_10_30,
        update: { ...SNAPSHOT_DONE_10_30 },
      }),
    ).toBe(false);
  });

  test("drops when status pair matches and both activities are null", () => {
    expect(
      shouldEmitPendingBootstrapUpdate({
        snapshot: { ...SNAPSHOT_DONE_10_30, activityAtMs: null },
        update: { ...SNAPSHOT_DONE_10_30, activityAtMs: null },
      }),
    ).toBe(false);
  });

  test("drops when update has no activity but snapshot did (lost activity)", () => {
    expect(
      shouldEmitPendingBootstrapUpdate({
        snapshot: SNAPSHOT_DONE_10_30,
        update: { ...SNAPSHOT_DONE_10_30, activityAtMs: null },
      }),
    ).toBe(false);
  });
});
