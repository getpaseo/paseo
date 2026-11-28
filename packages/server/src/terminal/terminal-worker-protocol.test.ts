import { describe, expect, it } from "vitest";
import {
  classifyTerminalWorkerProtocol,
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

it("drains v6 terminals while v7 supplies command lifecycle state", () => {
  expect(TERMINAL_WORKER_PROTOCOL_VERSION).toBe(7);
  expect(classifyTerminalWorkerProtocol(6)).toBe("previous");
});
