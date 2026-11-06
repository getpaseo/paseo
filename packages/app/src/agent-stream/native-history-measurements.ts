import {
  isHistoryViewportUnscrollable,
  type HistoryStartPaginationInput,
} from "./history-start-pagination";

const NATIVE_CONTAINER_KEY = "native-virtualized";

export interface NativeStreamViewportMetrics {
  containerKey: string;
  contentHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  offsetY: number;
  viewportMeasuredForKey: string | null;
  contentMeasuredForKey: string | null;
}

export function getNativeHistoryStartPaginationInput(input: {
  metrics: NativeStreamViewportMetrics;
  isReady: boolean;
  hasOlderHistory: boolean;
  isLoadingOlderHistory: boolean;
  progressKey: string | null;
}): HistoryStartPaginationInput {
  const { metrics } = input;
  return {
    distanceFromHistoryStart: metrics.offsetY,
    hasOlderHistory: input.hasOlderHistory,
    isLoadingOlderHistory: input.isLoadingOlderHistory,
    isReady:
      input.isReady &&
      metrics.viewportMeasuredForKey === metrics.containerKey &&
      metrics.contentMeasuredForKey === metrics.containerKey,
    progressKey: input.progressKey,
    autoFillUnscrollable: isHistoryViewportUnscrollable(metrics),
  };
}

export interface NativeHistoryMeasurementPort {
  readMetrics(): NativeStreamViewportMetrics;
  writeMetrics(metrics: NativeStreamViewportMetrics): void;
  isListPlaced(): boolean;
  markListPlaced(): void;
  onViewportChange(input: {
    previousViewportWidth: number;
    viewportWidth: number;
    previousViewportHeight: number;
    viewportHeight: number;
  }): void;
  onContentSizeChange(): void;
  onContentResize(): void;
  evaluateHistoryStart(): void;
  settleAfterContentResize(): void;
}

export function createNativeHistoryMeasurementEvents(port: NativeHistoryMeasurementPort) {
  return {
    onLayout(width: number, height: number) {
      const previous = port.readMetrics();
      const viewportWidth = Math.max(0, width);
      const viewportHeight = Math.max(0, height);
      port.writeMetrics({
        ...previous,
        containerKey: NATIVE_CONTAINER_KEY,
        viewportWidth,
        viewportHeight,
        viewportMeasuredForKey: NATIVE_CONTAINER_KEY,
      });
      port.onViewportChange({
        previousViewportWidth: previous.viewportWidth,
        viewportWidth,
        previousViewportHeight: previous.viewportHeight,
        viewportHeight,
      });
      port.evaluateHistoryStart();
    },
    onContentSizeChange(height: number) {
      port.writeMetrics({
        ...port.readMetrics(),
        containerKey: NATIVE_CONTAINER_KEY,
        contentHeight: Math.max(0, height),
        contentMeasuredForKey: port.isListPlaced() ? NATIVE_CONTAINER_KEY : null,
      });
      port.onContentSizeChange();
      port.onContentResize();
      port.evaluateHistoryStart();
      port.settleAfterContentResize();
    },
    onListPlaced() {
      port.markListPlaced();
      port.writeMetrics({
        ...port.readMetrics(),
        contentMeasuredForKey: NATIVE_CONTAINER_KEY,
      });
      port.onContentSizeChange();
      port.evaluateHistoryStart();
    },
  };
}
