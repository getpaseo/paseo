import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalEmulatorHandle } from "@/components/terminal-emulator-contract";
import type { FindResult } from "@/find/engine";
import { createTerminalFindEngine } from "@/find/terminal/engine.web";

type EmulatorCall = { method: "findNext" | "findPrevious"; term: string } | { method: "clearFind" };

function createEmulatorStub(): {
  handle: TerminalEmulatorHandle;
  calls: EmulatorCall[];
} {
  const calls: EmulatorCall[] = [];
  const unusedByFind = () => {
    throw new Error("The find engine only drives the emulator's find methods");
  };
  const handle = {
    writeOutput: unusedByFind,
    restoreOutput: unusedByFind,
    renderSnapshot: unusedByFind,
    paste: unusedByFind,
    copySelection: unusedByFind,
    clear: unusedByFind,
    claimSize: unusedByFind,
    showKeyboard: unusedByFind,
    blur: unusedByFind,
    findNext: (term: string) => {
      calls.push({ method: "findNext", term });
    },
    findPrevious: (term: string) => {
      calls.push({ method: "findPrevious", term });
    },
    clearFind: () => {
      calls.push({ method: "clearFind" });
    },
    getSelectionText: () => "",
  } as unknown as TerminalEmulatorHandle;

  return { handle, calls };
}

function createEngine() {
  const { handle, calls } = createEmulatorStub();
  const engine = createTerminalFindEngine({ getEmulator: () => handle });
  const results: FindResult[] = [];
  engine.subscribe((result) => {
    results.push(result);
  });
  return { engine, calls, results };
}

/** Long enough to pass the engine's typing settle window. */
function settleTypedQuery(): void {
  vi.advanceTimersByTime(200);
}

describe("terminal find engine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits the current result to a new subscriber", () => {
    const { results } = createEngine();

    expect(results).toEqual([{ count: 0, activeIndex: null }]);
  });

  // Every keystroke would otherwise cost a full scan of a scrollback the user can set to
  // a million lines, on the thread that renders the terminal's output.
  it("searches once the typed query settles, not once per keystroke", () => {
    const { engine, calls, results } = createEngine();

    engine.setQuery("nee");
    engine.setQuery("needle");
    expect(calls).toEqual([]);

    settleTypedQuery();
    engine.reportResults({ resultIndex: 2, resultCount: 9, countIsCapped: false });

    expect(calls).toEqual([{ method: "findNext", term: "needle" }]);
    expect(results.at(-1)).toEqual({ count: 9, activeIndex: 2 });
  });

  it("searches immediately when Enter arrives before the query settled", () => {
    const { engine, calls } = createEngine();

    engine.setQuery("needle");
    engine.next();
    settleTypedQuery();

    expect(calls).toEqual([{ method: "findNext", term: "needle" }]);
  });

  it("reports a capped count without a position, because the addon has none", () => {
    const { engine, results } = createEngine();

    engine.setQuery("error");
    engine.reportResults({ resultIndex: -1, resultCount: 1_000, countIsCapped: true });

    expect(results.at(-1)).toEqual({ count: 1_000, activeIndex: null, countIsCapped: true });
  });

  it("reports no active match when the addon has none", () => {
    const { engine, results } = createEngine();

    engine.setQuery("needle");
    engine.reportResults({ resultIndex: -1, resultCount: 0, countIsCapped: false });

    expect(results.at(-1)).toEqual({ count: 0, activeIndex: null });
  });

  it("clears the terminal when the query is emptied", () => {
    const { engine, calls, results } = createEngine();

    engine.setQuery("needle");
    engine.setQuery("");

    expect(calls.at(-1)).toEqual({ method: "clearFind" });
    expect(results.at(-1)).toEqual({ count: 0, activeIndex: null });
  });

  it("ignores stepping while no query is set", () => {
    const { engine, calls } = createEngine();

    engine.next();
    engine.previous();

    expect(calls).toEqual([]);
  });

  it("steps in both directions once a query is set", () => {
    const { engine, calls } = createEngine();

    engine.setQuery("needle");
    settleTypedQuery();
    engine.next();
    engine.previous();

    expect(calls).toEqual([
      { method: "findNext", term: "needle" },
      { method: "findNext", term: "needle" },
      { method: "findPrevious", term: "needle" },
    ]);
  });

  it("re-runs the query once after a buffer swap, past the escape sequence that caused it", () => {
    const { engine, calls } = createEngine();

    engine.setQuery("needle");
    settleTypedQuery();
    engine.reapply();
    engine.reapply();
    expect(calls).toHaveLength(1);

    vi.advanceTimersByTime(0);
    expect(calls).toEqual([
      { method: "findNext", term: "needle" },
      { method: "findNext", term: "needle" },
    ]);
  });

  it("does not re-run a buffer swap that arrives with the bar closed", () => {
    const { engine, calls } = createEngine();

    engine.reapply();
    vi.advanceTimersByTime(0);

    expect(calls).toEqual([]);
  });

  it("drops a pending buffer-swap search when the bar closes first", () => {
    const { engine, calls } = createEngine();

    engine.setQuery("needle");
    settleTypedQuery();
    engine.reapply();
    engine.clear();
    vi.advanceTimersByTime(0);

    expect(calls).toEqual([{ method: "findNext", term: "needle" }, { method: "clearFind" }]);
  });

  it("clears the terminal on dispose so a hidden pane keeps no decorations", () => {
    const { engine, calls } = createEngine();

    engine.setQuery("needle");
    settleTypedQuery();
    engine.dispose();

    expect(calls.at(-1)).toEqual({ method: "clearFind" });
  });
});
