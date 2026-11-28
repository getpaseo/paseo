import { describe, expect, it } from "vitest";
import {
  classifyTerminalWorkerProtocol,
  isUnsupportedForWorkerProtocol,
  TERMINAL_WORKER_PROTOCOL_VERSION,
} from "./terminal-worker-protocol.js";

describe("classifyTerminalWorkerProtocol", () => {
  it("rejects the unreleased cell protocol without a draining adapter", () => {
    expect(classifyTerminalWorkerProtocol(1, 2)).toBe("obsolete");
    expect(classifyTerminalWorkerProtocol(2, 3)).toBe("obsolete");
    expect(classifyTerminalWorkerProtocol(3, 4)).toBe("obsolete");
    expect(classifyTerminalWorkerProtocol(4, 5)).toBe("obsolete");
  });
  it.each([
    [7, "current"],
    [6, "previous"],
    [5, "obsolete"],
    [4, "obsolete"],
    [-1, "obsolete"],
    [8, "newer"],
    // A version this daemon cannot read comes from a Paseo it does not know.
    ["7", "newer"],
    [4.5, "newer"],
    [Number.NaN, "newer"],
    [undefined, "newer"],
  ])("a worker reporting %s to a daemon at 7 is %s", (reported, fit) => {
    expect(classifyTerminalWorkerProtocol(reported, 7)).toBe(fit);
  });
});

it("drains v6 terminals while v7 adds terminal palette support", () => {
  expect(TERMINAL_WORKER_PROTOCOL_VERSION).toBe(7);
  expect(classifyTerminalWorkerProtocol(6)).toBe("previous");
  expect(classifyTerminalWorkerProtocol(5)).toBe("obsolete");
});

it("drops v7 palette updates for draining v6 workers while keeping other sends", () => {
  const palette = {
    type: "palette" as const,
    defaultColors: { foreground: "#1a1a1e", background: "#ffffff" },
  };
  expect(isUnsupportedForWorkerProtocol({ type: "send", message: palette }, 6)).toBe(true);
  expect(isUnsupportedForWorkerProtocol({ type: "send", message: palette }, 7)).toBe(false);
  expect(
    isUnsupportedForWorkerProtocol({ type: "send", message: { type: "input", data: "hi" } }, 6),
  ).toBe(false);
  expect(
    isUnsupportedForWorkerProtocol(
      { type: "send", message: { type: "resize", rows: 24, cols: 80 } },
      6,
    ),
  ).toBe(false);
});
