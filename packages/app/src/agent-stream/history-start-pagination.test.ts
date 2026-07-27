import { describe, expect, it } from "vitest";
import {
  createHistoryStartPaginationState,
  evaluateHistoryStartPagination,
  isHistoryStartLoadingOperation,
  settleHistoryStartPagination,
  type HistoryStartPaginationInput,
} from "./history-start-pagination";

const visibleHistoryStart: HistoryStartPaginationInput = {
  distanceFromHistoryStart: 0,
  hasOlderHistory: true,
  isLoadingOlderHistory: false,
  isReady: true,
  progressKey: "epoch-1:20",
};

describe("history start pagination", () => {
  it("waits for anchored page geometry before authorizing another page", () => {
    const first = evaluateHistoryStartPagination(
      createHistoryStartPaginationState(),
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
      createHistoryStartPaginationState(),
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
      createHistoryStartPaginationState(),
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
      createHistoryStartPaginationState(),
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

  it("does not mistake repeated edge observations for a finished request", () => {
    const first = evaluateHistoryStartPagination(
      createHistoryStartPaginationState(),
      visibleHistoryStart,
    );
    const repeated = evaluateHistoryStartPagination(first.state, visibleHistoryStart);

    expect(repeated.state).toBe(first.state);
    expect(repeated.shouldLoad).toBe(false);
  });

  it("waits while history loading is unavailable or already active", () => {
    const state = createHistoryStartPaginationState();

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
