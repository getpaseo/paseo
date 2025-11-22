import { describe, expect, it, vi } from "vitest";
import { WaitForAgentTracker } from "./wait-for-agent-tracker.js";

describe("WaitForAgentTracker", () => {
  it("registers and cancels waiters per agent", () => {
    const tracker = new WaitForAgentTracker();
    const cancelA = vi.fn();
    const cancelB = vi.fn();

    tracker.register("agent-a", cancelA);
    tracker.register("agent-a", cancelB);

    expect(tracker.cancel("agent-a", "test")).toBe(true);
    expect(cancelA).toHaveBeenCalledWith("test");
    expect(cancelB).toHaveBeenCalledWith("test");

    // Subsequent cancels should no-op once cleared
    expect(tracker.cancel("agent-a")).toBe(false);

    // Unregister removes callback without triggering it
    const cancelC = vi.fn();
    const unregisterC = tracker.register("agent-b", cancelC);
    unregisterC();
    expect(tracker.cancel("agent-b")).toBe(false);
    expect(cancelC).not.toHaveBeenCalled();
  });

  it("supports cancelling all waiters", () => {
    const tracker = new WaitForAgentTracker();
    const cancelA = vi.fn();
    const cancelB = vi.fn();

    tracker.register("agent-a", cancelA);
    tracker.register("agent-b", cancelB);

    expect(tracker.cancelAll()).toBe(2);
    expect(cancelA).toHaveBeenCalled();
    expect(cancelB).toHaveBeenCalled();
  });
});
