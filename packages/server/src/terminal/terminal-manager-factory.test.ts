import { expect, it } from "vitest";
import { resolveTerminalBackend } from "./terminal-manager-factory.js";

it("uses the in-process terminal backend by default", () => {
  expect(resolveTerminalBackend({})).toBe("in-process");
});

it("opts into the worker terminal backend when HUBCODE_TERMINAL_BACKEND=worker", () => {
  expect(resolveTerminalBackend({ HUBCODE_TERMINAL_BACKEND: "worker" })).toBe("worker");
});
