import { describe, expect, it } from "vitest";
import { classifyTerminalWorkerProtocol } from "./terminal-worker-protocol.js";

describe("classifyTerminalWorkerProtocol", () => {
  it.each([
    [5, "current"],
    [4, "previous"],
    [3, "obsolete"],
    [-1, "obsolete"],
    [6, "newer"],
    // A version this daemon cannot read comes from a Paseo it does not know.
    ["6", "newer"],
    [4.5, "newer"],
    [Number.NaN, "newer"],
    [undefined, "newer"],
  ])("a worker reporting %s to a daemon at 5 is %s", (reported, fit) => {
    expect(classifyTerminalWorkerProtocol(reported, 5)).toBe(fit);
  });
});
