import { describe, expect, it, vi } from "vitest";
import {
  createHistoryStartPagination,
  type HistoryStartPaginationInput,
} from "./history-start-pagination";

const initial: HistoryStartPaginationInput = {
  distanceFromHistoryStart: 0,
  isUnderfilled: true,
  hasOlderHistory: true,
  isLoadingOlderHistory: false,
  isReady: true,
  progressKey: "20",
};

function harness(initiallyVisible = false) {
  let geometry = { ...initial };
  const requests: Array<(value: boolean) => void> = [];
  let settles = 0;
  const pagination = createHistoryStartPagination({
    initiallyVisible,
    read: () => geometry,
    load: () => new Promise<boolean>((resolve) => requests.push(resolve)),
    changed: () => {},
    scheduleSettle: () => {
      settles++;
    },
  });
  return {
    pagination,
    requests,
    get settles() {
      return settles;
    },
    set(patch: Partial<HistoryStartPaginationInput>) {
      geometry = { ...geometry, ...patch };
      pagination.update();
    },
  };
}

describe("history start pagination", () => {
  it("waits for a delayed request and its committed page before settling", async () => {
    const h = harness();
    h.pagination.update();
    h.set({ progressKey: "10" });
    expect(h.settles).toBe(0);
    h.requests[0](true);
    await Promise.resolve();
    expect(h.settles).toBe(1);
    expect(h.pagination.state.visible).toBe(false);
    h.set({ isUnderfilled: false });
    h.pagination.settle();
    expect(h.pagination.state).toEqual({ status: "dormant", visible: true });
    h.pagination.dispose();
  });
  it("waits for the committed page after a request completes", async () => {
    const h = harness();
    h.pagination.update();
    h.requests[0](true);
    await Promise.resolve();
    expect(h.settles).toBe(0);
    h.set({ progressKey: "10" });
    expect(h.settles).toBe(1);
    h.pagination.dispose();
  });
  it("continues short pages and reveals on exhaustion", async () => {
    const h = harness();
    h.pagination.update();
    h.set({ progressKey: "10" });
    h.requests[0](true);
    await Promise.resolve();
    h.pagination.settle();
    expect(h.requests).toHaveLength(2);
    h.set({ hasOlderHistory: false });
    h.requests[1](true);
    await Promise.resolve();
    expect(h.pagination.state).toEqual({ status: "dormant", visible: true });
    h.pagination.dispose();
  });
  it("releases a failed or stalled request and allows retry", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.pagination.update();
    vi.advanceTimersByTime(15_000);
    expect(h.pagination.state).toEqual({ status: "failed", visible: true });
    h.pagination.rearm();
    expect(h.requests).toHaveLength(2);
    h.requests[1](false);
    await Promise.resolve();
    expect(h.pagination.state.status).toBe("failed");
    h.pagination.dispose();
    vi.useRealTimers();
  });
  it("keeps visible history visible while filling", () => {
    const h = harness(true);
    h.pagination.update();
    expect(h.pagination.state.visible).toBe(true);
    h.pagination.dispose();
  });
  it("does not load a full viewport until user intent and respects inactive views", () => {
    const h = harness();
    h.set({ isUnderfilled: false });
    expect(h.requests).toHaveLength(0);
    h.set({ isReady: false });
    h.pagination.rearm();
    expect(h.requests).toHaveLength(0);
    h.set({ isReady: true });
    expect(h.requests).toHaveLength(1);
    h.pagination.dispose();
  });
  it("preserves the reading position after an anchored page moves away from the start", async () => {
    const h = harness(true);
    h.set({ isUnderfilled: false });
    h.pagination.rearm();
    h.set({ progressKey: "10", distanceFromHistoryStart: 300 });
    h.requests[0](true);
    await Promise.resolve();
    h.pagination.settle();
    expect(h.requests).toHaveLength(1);
    h.set({ distanceFromHistoryStart: 0 });
    expect(h.requests).toHaveLength(2);
    h.pagination.dispose();
  });
});

it("ignores a timed-out response after the reader retries", async () => {
  vi.useFakeTimers();
  const h = harness();
  h.pagination.update();
  vi.advanceTimersByTime(15_000);
  h.pagination.rearm();
  h.requests[0](true);
  await Promise.resolve();
  expect(h.pagination.state.status).toBe("loading");
  expect(h.settles).toBe(0);
  h.requests[1](false);
  await Promise.resolve();
  expect(h.pagination.state.status).toBe("failed");
  h.pagination.dispose();
  vi.useRealTimers();
});

it("does not repeat a successful page that made no progress", async () => {
  vi.useFakeTimers();
  const h = harness();
  h.pagination.update();
  h.requests[0](true);
  await Promise.resolve();
  h.pagination.update();
  expect(h.requests).toHaveLength(1);
  vi.advanceTimersByTime(15_000);
  expect(h.pagination.state).toEqual({ status: "failed", visible: true });
  h.pagination.dispose();
  vi.useRealTimers();
});

it("waits until the cursor and active history are available", () => {
  const h = harness();
  h.set({ isReady: false, progressKey: null });
  h.set({ isReady: true, isLoadingOlderHistory: true });
  h.set({ isLoadingOlderHistory: false });
  expect(h.requests).toHaveLength(0);
  h.set({ progressKey: "20" });
  expect(h.requests).toHaveLength(1);
  h.pagination.dispose();
});

it("reveals immediately on exhausted history without offering retry", () => {
  const h = harness();
  h.set({ hasOlderHistory: false });
  expect(h.requests).toHaveLength(0);
  expect(h.pagination.state).toEqual({ status: "dormant", visible: true });
  h.pagination.dispose();
});

it("keeps a settled page pending while its view is inactive", async () => {
  const h = harness();
  h.pagination.update();
  h.set({ progressKey: "10" });
  h.requests[0](true);
  await Promise.resolve();
  h.set({ isReady: false });
  h.pagination.settle();
  expect(h.pagination.state.status).toBe("settling");
  expect(h.requests).toHaveLength(1);
  h.set({ isReady: true, isUnderfilled: false });
  h.pagination.settle();
  expect(h.pagination.state).toEqual({ status: "dormant", visible: true });
  h.pagination.dispose();
});

it("keeps cached history visible after synchronization and subsequent pagination", async () => {
  const h = harness();
  h.pagination.reveal();
  h.pagination.update();
  h.set({ progressKey: "10" });
  h.requests[0](true);
  await Promise.resolve();
  h.pagination.settle();
  expect(h.pagination.state.visible).toBe(true);
  expect(h.requests).toHaveLength(2);
  h.pagination.dispose();
});
