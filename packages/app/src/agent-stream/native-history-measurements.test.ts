import { describe, expect, it } from "vitest";
import {
  createHistoryStartPaginationState,
  evaluateHistoryStartPagination,
  rearmHistoryStartPagination,
} from "./history-start-pagination";
import {
  createNativeHistoryMeasurementEvents,
  getNativeHistoryStartPaginationInput,
  type NativeHistoryMeasurementPort,
  type NativeStreamViewportMetrics,
} from "./native-history-measurements";

function createViewport() {
  let metrics: NativeStreamViewportMetrics = {
    containerKey: "native-virtualized",
    contentHeight: 0,
    viewportWidth: 0,
    viewportHeight: 0,
    offsetY: 0,
    viewportMeasuredForKey: null,
    contentMeasuredForKey: null,
  };
  let placed = false;
  let ready = true;
  let state = createHistoryStartPaginationState();
  const requests: string[] = [];
  const port: NativeHistoryMeasurementPort = {
    readMetrics: () => metrics,
    writeMetrics: (next) => {
      metrics = next;
    },
    isListPlaced: () => placed,
    markListPlaced: () => {
      placed = true;
    },
    onViewportChange: () => {},
    onContentSizeChange: () => {},
    onContentResize: () => {},
    evaluateHistoryStart: () => {
      const transition = evaluateHistoryStartPagination(
        state,
        getNativeHistoryStartPaginationInput({
          metrics,
          isReady: ready,
          hasOlderHistory: true,
          isLoadingOlderHistory: false,
          progressKey: "epoch-1:20",
        }),
      );
      state = transition.state;
      if (transition.shouldLoad) requests.push("epoch-1:20");
    },
    settleAfterContentResize: () => {},
  };
  const events = createNativeHistoryMeasurementEvents(port);
  return {
    events,
    requests,
    setReady(next: boolean) {
      ready = next;
      port.evaluateHistoryStart();
    },
    drag() {
      state = rearmHistoryStartPagination(state);
      port.evaluateHistoryStart();
    },
  };
}

describe("native history measurements", () => {
  it("loads once when the list is placed after its short content was measured", () => {
    const viewport = createViewport();
    viewport.events.onLayout(360, 600);
    viewport.events.onContentSizeChange(450);
    expect(viewport.requests).toEqual([]);

    viewport.events.onListPlaced();
    viewport.events.onContentSizeChange(450);
    expect(viewport.requests).toEqual(["epoch-1:20"]);
  });

  it("loads once when short content is measured after the list was placed", () => {
    const viewport = createViewport();
    viewport.events.onListPlaced();
    viewport.events.onLayout(360, 600);
    expect(viewport.requests).toEqual([]);

    viewport.events.onContentSizeChange(450);
    expect(viewport.requests).toEqual(["epoch-1:20"]);
  });

  it("waits for readiness even when a short list has been placed and measured", () => {
    const viewport = createViewport();
    viewport.setReady(false);
    viewport.events.onLayout(360, 600);
    viewport.events.onContentSizeChange(450);
    viewport.events.onListPlaced();
    expect(viewport.requests).toEqual([]);

    viewport.setReady(true);
    expect(viewport.requests).toEqual(["epoch-1:20"]);
  });

  it("still requires a gesture when the measured content can scroll", () => {
    const viewport = createViewport();
    viewport.events.onListPlaced();
    viewport.events.onLayout(360, 600);
    viewport.events.onContentSizeChange(900);
    expect(viewport.requests).toEqual([]);

    viewport.drag();
    expect(viewport.requests).toEqual(["epoch-1:20"]);
  });
});
