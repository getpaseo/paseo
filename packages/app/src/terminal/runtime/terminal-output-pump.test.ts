import { describe, expect, it, vi } from "vitest";

import { TerminalOutputPump } from "./terminal-output-pump";

describe("terminal-output-pump", () => {
  it("batches selected-terminal chunk bursts into ordered flushes", () => {
    vi.useFakeTimers();
    const chunks: Array<{ sequence: number; text: string }> = [];
    const pump = new TerminalOutputPump({
      maxOutputChars: 100,
      onSelectedOutputChunk: (chunk) => {
        chunks.push(chunk);
      },
    });

    pump.setSelectedTerminal({ terminalId: "term-1" });
    pump.append({ terminalId: "term-1", text: "a" });
    pump.append({ terminalId: "term-1", text: "b" });
    pump.append({ terminalId: "term-1", text: "c" });

    expect(chunks).toEqual([]);

    vi.runOnlyPendingTimers();

    expect(chunks).toEqual([
      { sequence: 1, text: "abc" },
    ]);

    vi.useRealTimers();
  });

  it("keeps per-terminal snapshots and switches selected stream deterministically", () => {
    vi.useFakeTimers();
    const chunks: Array<{ sequence: number; text: string }> = [];
    const pump = new TerminalOutputPump({
      maxOutputChars: 10,
      onSelectedOutputChunk: (chunk) => {
        chunks.push(chunk);
      },
    });

    pump.setSelectedTerminal({ terminalId: "term-1" });
    pump.append({ terminalId: "term-1", text: "hello" });
    vi.runOnlyPendingTimers();
    expect(pump.readSnapshot({ terminalId: "term-1" })).toBe("hello");

    pump.append({ terminalId: "term-2", text: "world" });
    vi.runOnlyPendingTimers();
    expect(pump.readSnapshot({ terminalId: "term-2" })).toBe("world");

    pump.setSelectedTerminal({ terminalId: "term-2" });
    pump.append({ terminalId: "term-2", text: "!" });
    vi.runOnlyPendingTimers();

    expect(chunks).toEqual([
      { sequence: 1, text: "hello" },
      { sequence: 2, text: "!" },
    ]);

    vi.useRealTimers();
  });

  it("resets selected output when clearing selected terminal", () => {
    vi.useFakeTimers();
    const chunks: Array<{ sequence: number; text: string }> = [];
    const pump = new TerminalOutputPump({
      maxOutputChars: 10,
      onSelectedOutputChunk: (chunk) => {
        chunks.push(chunk);
      },
    });

    pump.setSelectedTerminal({ terminalId: "term-1" });
    pump.append({ terminalId: "term-1", text: "abc" });
    vi.runOnlyPendingTimers();

    pump.clearTerminal({ terminalId: "term-1" });

    expect(pump.readSnapshot({ terminalId: "term-1" })).toBe("");
    expect(chunks).toEqual([
      { sequence: 1, text: "abc" },
      { sequence: 2, text: "" },
    ]);

    vi.useRealTimers();
  });

  it("prunes orphaned terminal buffers", () => {
    const pump = new TerminalOutputPump({
      maxOutputChars: 100,
      onSelectedOutputChunk: () => {},
    });

    pump.append({ terminalId: "a", text: "one" });
    pump.append({ terminalId: "b", text: "two" });
    pump.prune({ terminalIds: ["b"] });

    expect(pump.readSnapshot({ terminalId: "a" })).toBe("");
    expect(pump.readSnapshot({ terminalId: "b" })).toBe("two");
  });
});
