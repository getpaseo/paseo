import { afterEach, describe, expect, it } from "vitest";
import {
  hasEscapeDismissHandler,
  pushEscapeDismissHandler,
  runTopEscapeDismissHandler,
} from "./escape-dismiss-stack";

// The module is a process-wide singleton. Drain whatever a test leaves behind so
// cases stay order-independent.
const cleanups: Array<() => void> = [];

function push(handler: () => void): () => void {
  const dispose = pushEscapeDismissHandler(handler);
  cleanups.push(dispose);
  return dispose;
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe("escape-dismiss-stack", () => {
  it("reports no handler and runs nothing when empty", () => {
    expect(hasEscapeDismissHandler()).toBe(false);
    expect(runTopEscapeDismissHandler()).toBe(false);
  });

  it("runs the most recently pushed handler", () => {
    const calls: string[] = [];
    push(() => calls.push("first"));
    push(() => calls.push("second"));

    expect(hasEscapeDismissHandler()).toBe(true);
    expect(runTopEscapeDismissHandler()).toBe(true);
    expect(calls).toEqual(["second"]);
  });

  it("stops reporting a handler once its disposer runs", () => {
    const dispose = push(() => undefined);
    expect(hasEscapeDismissHandler()).toBe(true);

    dispose();
    expect(hasEscapeDismissHandler()).toBe(false);
    expect(runTopEscapeDismissHandler()).toBe(false);
  });

  it("removes only the disposed handler and runs the new top", () => {
    const calls: string[] = [];
    const disposeFirst = push(() => calls.push("first"));
    push(() => calls.push("second"));

    disposeFirst();
    expect(hasEscapeDismissHandler()).toBe(true);
    expect(runTopEscapeDismissHandler()).toBe(true);
    expect(calls).toEqual(["second"]);
  });

  it("falls back to the previous handler after the top is disposed", () => {
    const calls: string[] = [];
    push(() => calls.push("first"));
    const disposeSecond = push(() => calls.push("second"));

    disposeSecond();
    expect(runTopEscapeDismissHandler()).toBe(true);
    expect(calls).toEqual(["first"]);
  });
});
