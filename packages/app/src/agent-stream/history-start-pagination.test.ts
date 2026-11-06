import { describe, expect, it } from "vitest";
import {
  abandonHistoryStartPaginationRequest,
  createHistoryStartPaginationState,
  evaluateHistoryStartPagination,
  isHistoryStartLoadingOperation,
  isHistoryViewportUnscrollable,
  rearmHistoryStartPagination,
  settleHistoryStartPagination,
  type HistoryStartPaginationInput,
} from "./history-start-pagination";

function createArmedHistoryStartPaginationState() {
  return rearmHistoryStartPagination(createHistoryStartPaginationState());
}

const visibleHistoryStart: HistoryStartPaginationInput = {
  distanceFromHistoryStart: 0,
  hasOlderHistory: true,
  isLoadingOlderHistory: false,
  isReady: true,
  progressKey: "epoch-1:20",
};

describe("history start pagination", () => {
  it("treats locally revealed history as progress before remote pagination", () => {
    const first = evaluateHistoryStartPagination(
      createArmedHistoryStartPaginationState(),
      visibleHistoryStart,
    );
    const localReveal = evaluateHistoryStartPagination(first.state, {
      ...visibleHistoryStart,
      progressKey: "epoch-1:20:local-60",
    });

    expect(first.shouldLoad).toBe(true);
    expect(localReveal.state).toEqual({
      status: "settling",
      loadedProgressKey: "epoch-1:20:local-60",
    });
  });
  it("waits for user scroll intent before loading", () => {
    const dormant = createHistoryStartPaginationState();
    const evaluated = evaluateHistoryStartPagination(dormant, visibleHistoryStart);

    expect(evaluated).toEqual({ state: { status: "dormant" }, shouldLoad: false });
  });

  it.each([
    [500, 400, true],
    [500, 500, true],
    [500, 501, true],
    [500, 502, false],
    [0, 1, false],
    [500, 0, false],
    [Number.NaN, 100, false],
    [500, Number.POSITIVE_INFINITY, false],
  ])(
    "detects a measured unscrollable viewport (%s, %s)",
    (viewportHeight, contentHeight, expected) => {
      expect(isHistoryViewportUnscrollable({ viewportHeight, contentHeight })).toBe(expected);
    },
  );

  it("loads older history without a gesture when the measured native viewport cannot scroll", () => {
    const first = evaluateHistoryStartPagination(createHistoryStartPaginationState(), {
      ...visibleHistoryStart,
      autoFillUnscrollable: isHistoryViewportUnscrollable({
        viewportHeight: 600,
        contentHeight: 450,
      }),
    });
    expect(first.shouldLoad).toBe(true);
    expect(first.state).toEqual({
      status: "loading",
      requestedProgressKey: "epoch-1:20",
      requestObserved: false,
    });
  });

  it("does not auto-load an unready, exhausted, or already-loading history", () => {
    const input = { ...visibleHistoryStart, autoFillUnscrollable: true };
    const variations: Partial<HistoryStartPaginationInput>[] = [
      { isReady: false },
      { hasOlderHistory: false },
      { isLoadingOlderHistory: true },
      { progressKey: null },
      { autoFillUnscrollable: false },
    ];
    for (const variation of variations) {
      expect(
        evaluateHistoryStartPagination(createHistoryStartPaginationState(), {
          ...input,
          ...variation,
        }),
      ).toEqual({ state: { status: "dormant" }, shouldLoad: false });
    }
  });

  it("does not repeat an automatic request that finishes without progress", () => {
    const input = { ...visibleHistoryStart, autoFillUnscrollable: true };
    const first = evaluateHistoryStartPagination(createHistoryStartPaginationState(), input);
    const inFlight = evaluateHistoryStartPagination(first.state, {
      ...input,
      isLoadingOlderHistory: true,
    });
    const finished = evaluateHistoryStartPagination(inFlight.state, input);
    const repeated = evaluateHistoryStartPagination(finished.state, input);
    expect(finished.state).toEqual({ status: "latched" });
    expect(repeated).toEqual({ state: { status: "latched" }, shouldLoad: false });
  });

  it("waits for anchored page geometry before authorizing another page", () => {
    const first = evaluateHistoryStartPagination(
      createArmedHistoryStartPaginationState(),
      visibleHistoryStart,
    );
    const inFlight = evaluateHistoryStartPagination(first.state, {
      ...visibleHistoryStart,
      isLoadingOlderHistory: true,
    });
    const pageApplied = evaluateHistoryStartPagination(inFlight.state, {
      ...visibleHistoryStart,
      isLoadingOlderHistory: true,
      progressKey: "epoch-1:10",
    });

    expect([first.shouldLoad, inFlight.shouldLoad, pageApplied.shouldLoad]).toEqual([
      true,
      false,
      false,
    ]);
    expect(pageApplied.state).toEqual({ status: "settling", loadedProgressKey: "epoch-1:10" });
  });

  it("loads one page each time anchored geometry leaves and returns to history start", () => {
    const first = evaluateHistoryStartPagination(
      createArmedHistoryStartPaginationState(),
      visibleHistoryStart,
    );
    const pageApplied = evaluateHistoryStartPagination(first.state, {
      ...visibleHistoryStart,
      progressKey: "epoch-1:10",
    });
    const settledAway = settleHistoryStartPagination(pageApplied.state, {
      ...visibleHistoryStart,
      distanceFromHistoryStart: 300,
      progressKey: "epoch-1:10",
    });
    const returned = evaluateHistoryStartPagination(settledAway.state, {
      ...visibleHistoryStart,
      progressKey: "epoch-1:10",
    });

    expect([
      first.shouldLoad,
      pageApplied.shouldLoad,
      settledAway.shouldLoad,
      returned.shouldLoad,
    ]).toEqual([true, false, false, true]);
  });

  it("continues the same loading operation when anchored geometry remains at history start", () => {
    const first = evaluateHistoryStartPagination(
      createArmedHistoryStartPaginationState(),
      visibleHistoryStart,
    );
    const pageApplied = evaluateHistoryStartPagination(first.state, {
      ...visibleHistoryStart,
      progressKey: "epoch-1:10",
    });
    const continued = settleHistoryStartPagination(pageApplied.state, {
      ...visibleHistoryStart,
      progressKey: "epoch-1:10",
    });

    expect(continued.shouldLoad).toBe(true);
    expect(isHistoryStartLoadingOperation(first.state)).toBe(true);
    expect(isHistoryStartLoadingOperation(pageApplied.state)).toBe(true);
    expect(isHistoryStartLoadingOperation(continued.state)).toBe(true);
  });

  it("latches a request that finishes without cursor progress", () => {
    const first = evaluateHistoryStartPagination(
      createArmedHistoryStartPaginationState(),
      visibleHistoryStart,
    );
    const inFlight = evaluateHistoryStartPagination(first.state, {
      ...visibleHistoryStart,
      isLoadingOlderHistory: true,
    });
    const finished = evaluateHistoryStartPagination(inFlight.state, visibleHistoryStart);
    const duplicate = evaluateHistoryStartPagination(finished.state, visibleHistoryStart);
    const away = evaluateHistoryStartPagination(duplicate.state, {
      ...visibleHistoryStart,
      distanceFromHistoryStart: 300,
    });

    expect(finished.state).toEqual({ status: "latched" });
    expect([finished.shouldLoad, duplicate.shouldLoad, away.shouldLoad]).toEqual([
      false,
      false,
      false,
    ]);
    expect(away.state).toEqual({ status: "ready" });
  });

  it("allows another user attempt after a request finishes without progress", () => {
    const first = evaluateHistoryStartPagination(
      createArmedHistoryStartPaginationState(),
      visibleHistoryStart,
    );
    const inFlight = evaluateHistoryStartPagination(first.state, {
      ...visibleHistoryStart,
      isLoadingOlderHistory: true,
    });
    const failed = evaluateHistoryStartPagination(inFlight.state, visibleHistoryStart);
    const retried = evaluateHistoryStartPagination(
      rearmHistoryStartPagination(failed.state),
      visibleHistoryStart,
    );

    expect(failed.state).toEqual({ status: "latched" });
    expect(retried.shouldLoad).toBe(true);
  });

  it("latches an attempt that becomes invalid before entering flight", () => {
    const requested = evaluateHistoryStartPagination(
      createArmedHistoryStartPaginationState(),
      visibleHistoryStart,
    );

    expect(abandonHistoryStartPaginationRequest(requested.state, "epoch-1:20")).toEqual({
      status: "latched",
    });
  });

  it("does not mistake repeated edge observations for a finished request", () => {
    const first = evaluateHistoryStartPagination(
      createArmedHistoryStartPaginationState(),
      visibleHistoryStart,
    );
    const repeated = evaluateHistoryStartPagination(first.state, visibleHistoryStart);

    expect(repeated.state).toBe(first.state);
    expect(repeated.shouldLoad).toBe(false);
  });

  it("waits while history loading is unavailable or already active", () => {
    const state = createArmedHistoryStartPaginationState();

    expect([
      evaluateHistoryStartPagination(state, { ...visibleHistoryStart, isReady: false }).shouldLoad,
      evaluateHistoryStartPagination(state, { ...visibleHistoryStart, hasOlderHistory: false })
        .shouldLoad,
      evaluateHistoryStartPagination(state, { ...visibleHistoryStart, isLoadingOlderHistory: true })
        .shouldLoad,
      evaluateHistoryStartPagination(state, { ...visibleHistoryStart, progressKey: null })
        .shouldLoad,
    ]).toEqual([false, false, false, false]);
  });
});
