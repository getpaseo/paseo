import type { TerminalGridCellMetrics } from "./terminal-grid-metrics";
import type {
  TerminalBufferCoordinate,
  TerminalSelectionPoint,
  TerminalSelectionRange,
  TerminalSelectionViewport,
} from "./terminal-selection";
export const TERMINAL_SELECTION_GRIP_SIZE = 18;
const TERMINAL_GESTURE_LONG_PRESS_MS = 450;
const TERMINAL_GESTURE_TAP_TOLERANCE_PX = 8;

type Endpoint = "start" | "end";
interface Geometry {
  range: TerminalSelectionRange | null;
  viewport: TerminalSelectionViewport;
  metrics: TerminalGridCellMetrics;
}
interface Ports {
  getGeometry(): Geometry | null;
  onBeginHandle(endpoint: Endpoint, cols: number): void;
  onMoveHandle(coordinate: TerminalBufferCoordinate): void;
  onLongPress(point: TerminalSelectionPoint): void;
  onTap(): void;
  onScroll(direction: "up" | "down", rows: number): void;
  schedule(callback: () => void, delay: number): number;
  cancel(timer: number): void;
}

export function terminalSelectionHandles(geometry: Geometry): Array<{
  endpoint: Endpoint;
  x: number;
  y: number;
  gripX: number;
  gripY: number;
  gripDirection: "left" | "right";
  gripAbove: boolean;
  stemTop: number;
  stemHeight: number;
}> {
  const { range, viewport, metrics } = geometry;
  if (!range) return [];
  return (["start", "end"] as const).flatMap((endpoint) => {
    const cell = range[endpoint];
    if (cell.row < viewport.firstRow || cell.row >= viewport.firstRow + viewport.rows) return [];
    const x = (cell.col + (endpoint === "end" ? 1 : 0)) * metrics.cellWidth;
    const stemTop = (cell.row - viewport.firstRow) * metrics.cellHeight;
    const size = TERMINAL_SELECTION_GRIP_SIZE;
    const width = viewport.cols * metrics.cellWidth;
    const height = viewport.rows * metrics.cellHeight;
    const wantsLeft = endpoint === "start";
    const gripDirection =
      (wantsLeft && x >= size) || (!wantsLeft && x > width - size) ? "left" : "right";
    const gripAbove = stemTop + metrics.cellHeight + size > height;
    const gripTop = gripAbove ? Math.max(0, stemTop - size) : stemTop + metrics.cellHeight;
    return [
      {
        endpoint,
        x,
        y: stemTop + metrics.cellHeight / 2,
        gripX: x + (gripDirection === "left" ? -size / 2 : size / 2),
        gripY: gripTop + size / 2,
        gripDirection,
        gripAbove,
        stemTop,
        stemHeight: metrics.cellHeight,
      },
    ];
  });
}

export function createTerminalSelectionController(ports: Ports) {
  let press: {
    start: TerminalSelectionPoint;
    point: TerminalSelectionPoint;
    endpoint: Endpoint | null;
    offset: TerminalSelectionPoint;
    fixed: TerminalBufferCoordinate | null;
    moved: boolean;
    long: boolean;
    scrolling: boolean;
    remainder: number;
  } | null = null;
  let timer: number | null = null;
  function stopTimer() {
    if (timer !== null) ports.cancel(timer);
    timer = null;
  }
  function updateHandle() {
    const geometry = ports.getGeometry();
    if (!press || (!press.endpoint && !press.long) || !geometry) return;
    const { viewport, metrics } = geometry;
    const x = press.point.x - press.offset.x;
    const y = press.point.y - press.offset.y;
    let row =
      viewport.firstRow +
      Math.max(0, Math.min(viewport.rows - 1, Math.floor(y / metrics.cellHeight)));
    let col = Math.floor(x / metrics.cellWidth);
    if (press.endpoint && press.fixed) {
      const boundary = Math.round(x / metrics.cellWidth);
      const isEnd =
        row > press.fixed.row || (row === press.fixed.row && boundary > press.fixed.col);
      col = boundary - (isEnd ? 1 : 0);
      if (col < 0 && isEnd) {
        row -= 1;
        col = viewport.cols - 1;
      } else if (col >= viewport.cols && !isEnd) {
        row += 1;
        col = 0;
      }
    }
    col = Math.max(0, Math.min(viewport.cols - 1, col));
    ports.onMoveHandle({ row, col });
  }
  function edgeTick() {
    timer = null;
    const geometry = ports.getGeometry();
    if (!press || (!press.endpoint && !press.long) || !geometry) return;
    const y = press.point.y - press.offset.y;
    const height = geometry.viewport.rows * geometry.metrics.cellHeight;
    let direction: "up" | "down" | null = null;
    if (y < geometry.metrics.cellHeight) direction = "up";
    else if (y > height - geometry.metrics.cellHeight) direction = "down";
    if (!direction) return;
    ports.onScroll(direction, 1);
    if (!press) return;
    updateHandle();
    if (press) timer = ports.schedule(edgeTick, 100);
  }
  return {
    press(point: TerminalSelectionPoint) {
      stopTimer();
      const geometry = ports.getGeometry();
      const handles = geometry ? terminalSelectionHandles(geometry) : [];
      const handle = handles
        .map((item) => ({
          endpoint: item.endpoint,
          x: item.x,
          y: item.y,
          distance: Math.hypot(point.x - item.gripX, point.y - item.gripY),
        }))
        .filter((item) => item.distance <= 28)
        .sort((a, b) => a.distance - b.distance)[0];
      press = {
        start: point,
        point,
        endpoint: handle?.endpoint ?? null,
        offset: handle ? { x: point.x - handle.x, y: point.y - handle.y } : { x: 0, y: 0 },
        fixed:
          handle && geometry?.range
            ? geometry.range[handle.endpoint === "start" ? "end" : "start"]
            : null,
        moved: false,
        long: false,
        scrolling: false,
        remainder: 0,
      };
      if (handle && geometry) {
        ports.onBeginHandle(handle.endpoint, geometry.viewport.cols);
        return;
      }
      timer = ports.schedule(() => {
        timer = null;
        if (press && !press.moved) {
          press.long = true;
          ports.onLongPress(press.start);
        }
      }, TERMINAL_GESTURE_LONG_PRESS_MS);
    },
    move(point: TerminalSelectionPoint) {
      if (!press) return;
      const previous = press.point;
      press.point = point;
      const dx = point.x - press.start.x,
        dy = point.y - press.start.y;
      if (Math.hypot(dx, dy) > TERMINAL_GESTURE_TAP_TOLERANCE_PX) {
        press.moved = true;
        if (!press.endpoint) stopTimer();
      }
      if (press.endpoint || press.long) {
        if (press.endpoint || press.moved) {
          updateHandle();
          stopTimer();
          if (press) timer = ports.schedule(edgeTick, 100);
        }
      } else if (!press.long) {
        if (!press.scrolling && Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
          press.scrolling = true;
          press.remainder = dy;
        } else if (press.scrolling) press.remainder += point.y - previous.y;
        const height = ports.getGeometry()?.metrics.cellHeight ?? 0;
        if (press.scrolling && height > 0) {
          const rows = Math.trunc(press.remainder / height);
          press.remainder -= rows * height;
          if (rows) ports.onScroll(rows > 0 ? "up" : "down", Math.abs(rows));
        }
      }
    },
    release() {
      stopTimer();
      if (press && !press.endpoint && !press.long && !press.moved) ports.onTap();
      press = null;
    },
    cancel() {
      stopTimer();
      press = null;
    },
  };
}
