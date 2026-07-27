import { describe, expect, it } from "vitest";
import {
  createHistoryStartPaginationState,
  evaluateHistoryStartPagination,
  rearmHistoryStartPagination,
} from "./history-start-pagination";

const visibleHistoryStart = {
  distanceFromHistoryStart: 0,
  hasOlderHistory: true,
  isLoadingOlderHistory: false,
  isReady: true,
  progressKey: "epoch-1:20",
};

describe("history start pagination", () => {
  it("loads once for each authoritative history cursor", () => {
    const initial = createHistoryStartPaginationState();
    const first = evaluateHistoryStartPagination(initial, visibleHistoryStart);
    const duplicate = evaluateHistoryStartPagination(first.state, visibleHistoryStart);
    const nextPage = evaluateHistoryStartPagination(first.state, {
      ...visibleHistoryStart,
      progressKey: "epoch-1:10",
    });

    expect([first.shouldLoad, duplicate.shouldLoad, nextPage.shouldLoad]).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("allows the same revision again after the user leaves the history edge", () => {
    const first = evaluateHistoryStartPagination(
      createHistoryStartPaginationState(),
      visibleHistoryStart,
    );
    const away = evaluateHistoryStartPagination(first.state, {
      ...visibleHistoryStart,
      distanceFromHistoryStart: 200,
    });
    const returned = evaluateHistoryStartPagination(away.state, visibleHistoryStart);

    expect([first.shouldLoad, away.shouldLoad, returned.shouldLoad]).toEqual([true, false, true]);
  });

  it("re-arms the same cursor when the user makes another upward edge gesture", () => {
    const first = evaluateHistoryStartPagination(
      createHistoryStartPaginationState(),
      visibleHistoryStart,
    );
    const retried = evaluateHistoryStartPagination(
      rearmHistoryStartPagination(first.state),
      visibleHistoryStart,
    );

    expect([first.shouldLoad, retried.shouldLoad]).toEqual([true, true]);
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
