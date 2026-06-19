import { performance } from "node:perf_hooks";
import { describe, expect, test } from "vitest";

import { createTerminalCellStyleResolver, DEFAULT_TERMINAL_THEME } from "./colors";
import { createNativeHeadlessTerminal } from "./headless-terminal-state";
import { createNativeTerminalBenchmarkPayload } from "./native-terminal-benchmark-payload";
import { buildRows } from "./terminal-row-model";

const RUN_BENCHMARKS = process.env.PASEO_NATIVE_TERMINAL_BENCH === "1";
const ROWS = 40;
const COLS = 120;
const SCROLLBACK_LINES = [100, 1000, 10_000] as const;
const BURST_LINES = [10, 100, 1000] as const;
const SAMPLE_COUNT = 3;

interface NativeTerminalBenchmarkResult {
  scrollback: number;
  burstLines: number;
  feedMs: number;
  fullStateMs: number;
  viewportStateMs: number;
  visibleRowModelsMs: number;
  hypotheticalAllRowModelsMs: number;
  scrollbackRowsRead: number;
  visibleRowsRead: number;
  visibleRowsBuilt: number;
  hypotheticalAllRowsBuilt: number;
}

function fixed(value: number): number {
  return Number(value.toFixed(2));
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function seedScrollback(input: { scrollback: number }) {
  const terminal = createNativeHeadlessTerminal({
    rows: ROWS,
    cols: COLS,
    scrollbackLines: input.scrollback,
  });
  await terminal.write(
    createNativeTerminalBenchmarkPayload({
      startLine: 0,
      lineCount: input.scrollback + ROWS + 5,
      cols: COLS,
    }),
  );
  return terminal;
}

async function measureScenario(input: {
  scrollback: number;
  burstLines: number;
}): Promise<NativeTerminalBenchmarkResult> {
  const terminal = await seedScrollback({ scrollback: input.scrollback });
  const resolver = createTerminalCellStyleResolver(DEFAULT_TERMINAL_THEME);
  const feedTimes: number[] = [];
  const fullStateTimes: number[] = [];
  const viewportStateTimes: number[] = [];
  const visibleRowModelTimes: number[] = [];
  const allRowModelTimes: number[] = [];
  let scrollbackRowsRead = 0;
  let visibleRowsRead = 0;
  let visibleRowsBuilt = 0;
  let hypotheticalAllRowsBuilt = 0;

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const payload = createNativeTerminalBenchmarkPayload({
      startLine: input.scrollback + sample * input.burstLines,
      lineCount: input.burstLines,
      cols: COLS,
    });

    const feedStart = performance.now();
    await terminal.write(payload);
    feedTimes.push(performance.now() - feedStart);

    const stateStart = performance.now();
    const state = terminal.getState();
    fullStateTimes.push(performance.now() - stateStart);

    const viewportStateStart = performance.now();
    const viewportState = terminal.getViewportState();
    viewportStateTimes.push(performance.now() - viewportStateStart);

    const visibleRowsStart = performance.now();
    const visibleRows = buildRows({ grid: viewportState.grid, resolver });
    visibleRowModelTimes.push(performance.now() - visibleRowsStart);

    const allRowsStart = performance.now();
    const allRows = buildRows({ grid: [...state.scrollback, ...state.grid], resolver });
    allRowModelTimes.push(performance.now() - allRowsStart);

    scrollbackRowsRead = state.scrollback.length;
    visibleRowsRead = state.grid.length;
    visibleRowsBuilt = visibleRows.length;
    hypotheticalAllRowsBuilt = allRows.length;
  }

  terminal.dispose();

  return {
    scrollback: input.scrollback,
    burstLines: input.burstLines,
    feedMs: fixed(median(feedTimes)),
    fullStateMs: fixed(median(fullStateTimes)),
    viewportStateMs: fixed(median(viewportStateTimes)),
    visibleRowModelsMs: fixed(median(visibleRowModelTimes)),
    hypotheticalAllRowModelsMs: fixed(median(allRowModelTimes)),
    scrollbackRowsRead,
    visibleRowsRead,
    visibleRowsBuilt,
    hypotheticalAllRowsBuilt,
  };
}

(RUN_BENCHMARKS ? describe : describe.skip)("native terminal renderer benchmark", () => {
  test("measures parse, state extraction, and row model cost against scrollback size", async () => {
    const results: NativeTerminalBenchmarkResult[] = [];

    for (const scrollback of SCROLLBACK_LINES) {
      for (const burstLines of BURST_LINES) {
        results.push(await measureScenario({ scrollback, burstLines }));
      }
    }

    console.table(results);
    console.log(`PASEO_NATIVE_TERMINAL_BENCH=${JSON.stringify(results, null, 2)}`);
    expect(results).toHaveLength(SCROLLBACK_LINES.length * BURST_LINES.length);
  }, 120_000);
});

if (!RUN_BENCHMARKS) {
  describe("native terminal renderer benchmark", () => {
    test("is opt-in", () => {
      expect(process.env.PASEO_NATIVE_TERMINAL_BENCH).not.toBe("1");
    });
  });
}
