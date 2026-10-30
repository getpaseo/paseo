import { describe, expect, it } from "vitest";
import { classifyTerminalWorkerProtocol } from "./terminal-worker-protocol.js";

describe("classifyTerminalWorkerProtocol", () => {
  it("rejects the unreleased cell protocol without a draining adapter", () => {
    expect(classifyTerminalWorkerProtocol(1, 2)).toBe("obsolete");
    expect(classifyTerminalWorkerProtocol(2, 3)).toBe("obsolete");
    expect(classifyTerminalWorkerProtocol(3, 4)).toBe("obsolete");
    expect(classifyTerminalWorkerProtocol(4, 5)).toBe("obsolete");
  });
  it.each([
    [6, "current"],
    [5, "previous"],
    [4, "obsolete"],
    [-1, "obsolete"],
    [7, "newer"],
    // A version this daemon cannot read comes from a Paseo it does not know.
    ["6", "newer"],
    [4.5, "newer"],
    [Number.NaN, "newer"],
    [undefined, "newer"],
  ])("a worker reporting %s to a daemon at 6 is %s", (reported, fit) => {
    expect(classifyTerminalWorkerProtocol(reported, 6)).toBe(fit);
  });
});
