import { describe, expect, it } from "vitest";
import {
  createHistoryStartPaginationState,
  evaluateHistoryStartPagination,
} from "./history-start-pagination";

const visibleHistoryStart = {
  distanceFromHistoryStart: 0,
  hasOlderHistory: true,
  isLoadingOlderHistory: false,
  isReady: true,
  revision: "history-1",
};

describe("history start pagination", () => {
  it("loads once for each visible history revision", () => {
    const initial = createHistoryStartPaginationState();
    const first = evaluateHistoryStartPagination(initial, visibleHistoryStart);
    const duplicate = evaluateHistoryStartPagination(first.state, visibleHistoryStart);
    const nextPage = evaluateHistoryStartPagination(first.state, {
      ...visibleHistoryStart,
      revision: "history-2",
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

  it("waits while history loading is unavailable or already active", () => {
    const state = createHistoryStartPaginationState();

    expect([
      evaluateHistoryStartPagination(state, { ...visibleHistoryStart, isReady: false }).shouldLoad,
      evaluateHistoryStartPagination(state, { ...visibleHistoryStart, hasOlderHistory: false })
        .shouldLoad,
      evaluateHistoryStartPagination(state, { ...visibleHistoryStart, isLoadingOlderHistory: true })
        .shouldLoad,
    ]).toEqual([false, false, false]);
  });
});
