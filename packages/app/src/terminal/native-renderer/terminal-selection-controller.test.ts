import { describe, expect, it } from "vitest";
import { createNativeHeadlessTerminal } from "./headless-terminal-state";
import {
  createTerminalSelectionModel,
  extractTerminalSelectedText,
  resolveTerminalSelectionRects,
} from "./terminal-selection";
import {
  createTerminalSelectionController,
  terminalSelectionHandles,
} from "./terminal-selection-controller";

describe("selection handle controller", () => {
  it("preserves the grab offset while moving a handle", () => {
    const range = { start: { row: 1, col: 2 }, end: { row: 1, col: 5 }, coordinateEpoch: 0 };
    const moves: Array<{ row: number; col: number }> = [];
    const controller = createTerminalSelectionController({
      getGeometry: () => ({
        range,
        viewport: { firstRow: 0, rows: 10, cols: 10 },
        metrics: { cellWidth: 10, cellHeight: 10 },
      }),
      onBeginHandle: () => {},
      onMoveHandle: (coordinate) => moves.push(coordinate),
      onLongPress: () => {},
      onTap: () => {},
      onScroll: () => {},
      schedule: () => 1,
      cancel: () => {},
    });
    controller.press({ x: 23, y: 15 });
    controller.move({ x: 63, y: 15 });
    controller.release();
    expect(moves).toEqual([{ row: 1, col: 5 }]);
  });
});

it("selects on hold, preserves a handle tap, and cancels an active drag", () => {
  const actions: string[] = [];
  let timer: (() => void) | null = null;
  const controller = createTerminalSelectionController({
    getGeometry: () => ({
      range: { start: { row: 2, col: 2 }, end: { row: 2, col: 5 }, coordinateEpoch: 0 },
      viewport: { firstRow: 0, rows: 10, cols: 10 },
      metrics: { cellWidth: 10, cellHeight: 10 },
    }),
    onBeginHandle: (endpoint) => actions.push(endpoint),
    onMoveHandle: () => actions.push("move"),
    onLongPress: () => actions.push("long"),
    onTap: () => actions.push("tap"),
    onScroll: () => actions.push("scroll"),
    schedule: (callback) => {
      timer = callback;
      return 1;
    },
    cancel: () => {
      timer = null;
    },
  });
  controller.press({ x: 90, y: 80 });
  (timer as (() => void) | null)?.();
  controller.release();
  controller.press({ x: 20, y: 25 });
  controller.release();
  controller.press({ x: 20, y: 25 });
  controller.cancel();
  controller.move({ x: 50, y: 25 });
  expect(actions).toEqual(["long", "start", "start"]);
});

it("scrolls selection into history while holding a handle at the edge", () => {
  let firstRow = 10;
  let timer: (() => void) | null = null;
  const coordinates: Array<{ row: number; col: number }> = [];
  const controller = createTerminalSelectionController({
    getGeometry: () => ({
      range: { start: { row: 12, col: 2 }, end: { row: 13, col: 5 }, coordinateEpoch: 0 },
      viewport: { firstRow, rows: 10, cols: 10 },
      metrics: { cellWidth: 10, cellHeight: 10 },
    }),
    onBeginHandle: () => {},
    onMoveHandle: (point) => coordinates.push(point),
    onLongPress: () => {},
    onTap: () => {},
    onScroll: (direction) => {
      if (direction === "up") firstRow--;
    },
    schedule: (callback) => {
      timer = callback;
      return 1;
    },
    cancel: () => {
      timer = null;
    },
  });
  controller.press({ x: 20, y: 25 });
  controller.move({ x: 20, y: 1 });
  (timer as (() => void) | null)?.();
  (timer as (() => void) | null)?.();
  controller.release();
  expect(coordinates).toEqual([
    { row: 10, col: 2 },
    { row: 9, col: 2 },
    { row: 8, col: 2 },
  ]);
  expect(timer).toBeNull();
});

it("scrolls outside handles without clearing selection and clears on an outside tap", () => {
  const actions: string[] = [];
  const controller = createTerminalSelectionController({
    getGeometry: () => ({
      range: { start: { row: 2, col: 2 }, end: { row: 2, col: 5 }, coordinateEpoch: 0 },
      viewport: { firstRow: 0, rows: 10, cols: 10 },
      metrics: { cellWidth: 10, cellHeight: 10 },
    }),
    onBeginHandle: () => actions.push("handle"),
    onMoveHandle: () => actions.push("move"),
    onLongPress: () => actions.push("long"),
    onTap: () => actions.push("tap"),
    onScroll: (direction, rows) => actions.push(`${direction}:${rows}`),
    schedule: () => 1,
    cancel: () => {},
  });
  controller.press({ x: 95, y: 70 });
  controller.move({ x: 95, y: 90 });
  controller.release();
  controller.press({ x: 95, y: 70 });
  controller.release();
  expect(actions).toEqual(["up:2", "tap"]);
});

it("extends the selection after a long press and drag", () => {
  let timer: (() => void) | null = null;
  const moves: Array<{ row: number; col: number }> = [];
  const controller = createTerminalSelectionController({
    getGeometry: () => ({
      range: null,
      viewport: { firstRow: 0, rows: 10, cols: 10 },
      metrics: { cellWidth: 10, cellHeight: 10 },
    }),
    onBeginHandle: () => {},
    onMoveHandle: (coordinate) => moves.push(coordinate),
    onLongPress: () => {},
    onTap: () => {},
    onScroll: () => {},
    schedule: (callback) => {
      timer = callback;
      return 1;
    },
    cancel: () => {
      timer = null;
    },
  });
  controller.press({ x: 25, y: 25 });
  (timer as (() => void) | null)?.();
  controller.move({ x: 65, y: 35 });
  controller.release();
  expect(moves).toEqual([{ row: 3, col: 6 }]);
});

it.each([
  {
    endpoint: "start" as const,
    startX: 20,
    crossedX: 80,
    crossedText: "gh",
    crossedStart: 6,
    crossedEnd: 7,
    backX: 10,
    backText: "bcdef",
    backStart: 1,
    backEnd: 5,
  },
  {
    endpoint: "end" as const,
    startX: 60,
    crossedX: 10,
    crossedText: "b",
    crossedStart: 1,
    crossedEnd: 1,
    backX: 80,
    backText: "cdefgh",
    backStart: 2,
    backEnd: 7,
  },
])("tracks the $endpoint handle through crossing and back", async (scenario) => {
  const terminal = createNativeHeadlessTerminal({ rows: 4, cols: 10 });
  try {
    await terminal.write("abcdefghij");
    const bounds = terminal.getBufferBounds();
    const model = createTerminalSelectionModel();
    model.begin({ coordinate: { row: 0, col: 2 }, bounds });
    model.update({ coordinate: { row: 0, col: 5 }, bounds });
    const viewport = { firstRow: 0, rows: 4, cols: 10 };
    const metrics = { cellWidth: 10, cellHeight: 10 };
    const geometry = () => ({ range: model.getSnapshot().range, viewport, metrics });
    const controller = createTerminalSelectionController({
      getGeometry: geometry,
      onBeginHandle: (endpoint, cols) => model.beginEndpointDrag(endpoint, cols),
      onMoveHandle: (coordinate) => {
        model.update({ coordinate, bounds });
      },
      onLongPress: () => {},
      onTap: () => {},
      onScroll: () => {},
      schedule: () => 1,
      cancel: () => {},
    });
    const check = (start: number, end: number, text: string) => {
      const range = model.getSnapshot().range;
      expect(range).toEqual({
        start: { row: 0, col: start },
        end: { row: 0, col: end },
        coordinateEpoch: bounds.coordinateEpoch,
      });
      expect(terminalSelectionHandles(geometry())).toMatchObject([
        { endpoint: "start", x: start * 10, y: 5 },
        { endpoint: "end", x: (end + 1) * 10, y: 5 },
      ]);
      expect(resolveTerminalSelectionRects({ selection: range, viewport, metrics })).toEqual([
        {
          key: `0:${start}:${end}`,
          x: start * 10,
          y: 0,
          width: (end - start + 1) * 10,
          height: 10,
        },
      ]);
      expect(extractTerminalSelectedText({ terminal, selection: range })).toBe(text);
    };
    controller.press({ x: scenario.startX, y: 5 });
    controller.move({ x: scenario.crossedX, y: 5 });
    check(scenario.crossedStart, scenario.crossedEnd, scenario.crossedText);
    controller.move({ x: scenario.backX, y: 5 });
    check(scenario.backStart, scenario.backEnd, scenario.backText);
    controller.release();
  } finally {
    terminal.dispose();
  }
});

it.each([
  {
    endpoint: "end" as const,
    initialRow: 0,
    targetRow: 1,
    targetX: 0,
    expectedRow: 0,
    expectedCol: 9,
    text: "cdefghij",
  },
  {
    endpoint: "start" as const,
    initialRow: 1,
    targetRow: 0,
    targetX: 100,
    expectedRow: 1,
    expectedCol: 0,
    text: "KLMNOP",
  },
])("preserves a $endpoint boundary at a row edge", async (scenario) => {
  const terminal = createNativeHeadlessTerminal({ rows: 4, cols: 10 });
  try {
    await terminal.write("abcdefghij\r\nKLMNOPQRST");
    const bounds = terminal.getBufferBounds();
    const model = createTerminalSelectionModel();
    model.begin({ coordinate: { row: scenario.initialRow, col: 2 }, bounds });
    model.update({ coordinate: { row: scenario.initialRow, col: 5 }, bounds });
    const viewport = { firstRow: 0, rows: 4, cols: 10 };
    const metrics = { cellWidth: 10, cellHeight: 10 };
    const geometry = () => ({ range: model.getSnapshot().range, viewport, metrics });
    const controller = createTerminalSelectionController({
      getGeometry: geometry,
      onBeginHandle: (endpoint, cols) => model.beginEndpointDrag(endpoint, cols),
      onMoveHandle: (coordinate) => {
        model.update({ coordinate, bounds });
      },
      onLongPress: () => {},
      onTap: () => {},
      onScroll: () => {},
      schedule: () => 1,
      cancel: () => {},
    });
    controller.press({ x: scenario.endpoint === "end" ? 60 : 20, y: scenario.initialRow * 10 + 5 });
    controller.move({ x: scenario.targetX, y: scenario.targetRow * 10 + 5 });
    const range = model.getSnapshot().range;
    expect(range?.[scenario.endpoint]).toEqual({
      row: scenario.expectedRow,
      col: scenario.expectedCol,
    });
    expect(extractTerminalSelectedText({ terminal, selection: range })).toBe(scenario.text);
    expect(
      terminalSelectionHandles(geometry()).find((handle) => handle.endpoint === scenario.endpoint),
    ).toMatchObject({
      x: scenario.endpoint === "end" ? 100 : 0,
      y: scenario.expectedRow * 10 + 5,
    });
    controller.release();
  } finally {
    terminal.dispose();
  }
});

it("cancels a drag when buffer coordinates are invalidated", () => {
  const model = createTerminalSelectionModel();
  const bounds = { oldestRow: 0, newestRow: 9, coordinateEpoch: 0 };
  model.begin({ coordinate: { row: 2, col: 2 }, bounds });
  model.update({ coordinate: { row: 2, col: 5 }, bounds });
  const viewport = { firstRow: 0, rows: 10, cols: 10 };
  const metrics = { cellWidth: 10, cellHeight: 10 };
  const controller = createTerminalSelectionController({
    getGeometry: () => ({ range: model.getSnapshot().range, viewport, metrics }),
    onBeginHandle: (endpoint, cols) => model.beginEndpointDrag(endpoint, cols),
    onMoveHandle: (coordinate) => {
      model.update({ coordinate, bounds });
    },
    onLongPress: () => {},
    onTap: () => {},
    onScroll: () => {},
    schedule: () => 1,
    cancel: () => {},
  });
  controller.press({ x: 20, y: 25 });
  const previous = model.getSnapshot().range;
  const snapshot = model.sync({ bounds: { ...bounds, coordinateEpoch: 1 } });
  if (previous && !snapshot.range) controller.cancel();
  controller.move({ x: 80, y: 25 });
  controller.release();
  expect(model.getSnapshot().range).toBeNull();
});

it("preserves a newly selected word through small movement at the viewport edge", () => {
  const model = createTerminalSelectionModel();
  const bounds = { oldestRow: 0, newestRow: 9, coordinateEpoch: 0 };
  let timer: (() => void) | null = null;
  const controller = createTerminalSelectionController({
    getGeometry: () => ({
      range: model.getSnapshot().range,
      viewport: { firstRow: 0, rows: 10, cols: 20 },
      metrics: { cellWidth: 10, cellHeight: 10 },
    }),
    onBeginHandle: (endpoint, cols) => model.beginEndpointDrag(endpoint, cols),
    onMoveHandle: (coordinate) => {
      model.update({ coordinate, bounds });
    },
    onLongPress: () => {
      model.begin({ coordinate: { row: 0, col: 2 }, bounds });
      model.update({ coordinate: { row: 0, col: 6 }, bounds });
    },
    onTap: () => {},
    onScroll: () => {},
    schedule: (callback) => {
      timer = callback;
      return 1;
    },
    cancel: () => {
      timer = null;
    },
  });
  controller.press({ x: 45, y: 5 });
  const fire = timer as (() => void) | null;
  timer = null;
  fire?.();
  controller.move({ x: 44, y: 4 });
  controller.release();
  expect(model.getSnapshot().range).toEqual({
    start: { row: 0, col: 2 },
    end: { row: 0, col: 6 },
    coordinateEpoch: 0,
  });
  expect(timer).toBeNull();
});

it("places mirrored teardrop grips below the selected row", () => {
  const handles = terminalSelectionHandles({
    range: { start: { row: 2, col: 2 }, end: { row: 2, col: 5 }, coordinateEpoch: 0 },
    viewport: { firstRow: 0, rows: 10, cols: 10 },
    metrics: { cellWidth: 10, cellHeight: 10 },
  });
  expect(handles).toMatchObject([
    { endpoint: "start", x: 20, y: 25, gripX: 11, gripY: 39, gripDirection: "left" },
    { endpoint: "end", x: 60, y: 25, gripX: 69, gripY: 39, gripDirection: "right" },
  ]);
});

it("keeps edge grips reachable and preserves the offset from the cell when dragging a grip", () => {
  const range = { start: { row: 0, col: 0 }, end: { row: 9, col: 9 }, coordinateEpoch: 0 };
  const viewport = { firstRow: 0, rows: 10, cols: 10 };
  const metrics = { cellWidth: 10, cellHeight: 10 };
  const handles = terminalSelectionHandles({ range, viewport, metrics });
  expect(handles.map(({ gripX, gripY }) => ({ gripX, gripY }))).toEqual([
    { gripX: 9, gripY: 19 },
    { gripX: 91, gripY: 81 },
  ]);
  const moves: Array<{ row: number; col: number }> = [];
  const controller = createTerminalSelectionController({
    getGeometry: () => ({ range, viewport, metrics }),
    onBeginHandle: () => {},
    onMoveHandle: (coordinate) => moves.push(coordinate),
    onLongPress: () => {},
    onTap: () => {},
    onScroll: () => {},
    schedule: () => 1,
    cancel: () => {},
  });
  controller.press({ x: 9, y: 19 });
  controller.move({ x: 19, y: 29 });
  controller.release();
  expect(moves).toEqual([{ row: 1, col: 1 }]);
});
