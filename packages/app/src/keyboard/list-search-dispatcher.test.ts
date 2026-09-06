import { describe, expect, it, vi } from "vitest";
import { createListSearchDispatcher } from "./list-search-dispatcher";

describe("listSearchDispatcher", () => {
  it("routes to the newest equally-prioritized handler", () => {
    const dispatcher = createListSearchDispatcher();
    const older = vi.fn(() => true);
    const newer = vi.fn(() => true);
    dispatcher.registerHandler({ handlerId: "older", enabled: true, handle: older });
    dispatcher.registerHandler({ handlerId: "newer", enabled: true, handle: newer });

    expect(dispatcher.dispatch({ key: "n", ctrlKey: true })).toBe(true);
    expect(newer).toHaveBeenCalledWith("next", { key: "n", ctrlKey: true });
    expect(older).not.toHaveBeenCalled();
  });

  it("falls through disabled and unhandled registrations", () => {
    const dispatcher = createListSearchDispatcher();
    const fallback = vi.fn(() => true);
    dispatcher.registerHandler({ handlerId: "fallback", enabled: true, handle: fallback });
    dispatcher.registerHandler({ handlerId: "disabled", enabled: false, handle: () => true });
    dispatcher.registerHandler({
      handlerId: "top",
      enabled: true,
      priority: 1,
      handle: () => false,
    });

    expect(dispatcher.dispatch({ key: "p", ctrlKey: true })).toBe(true);
    expect(fallback).toHaveBeenCalledWith("previous", { key: "p", ctrlKey: true });
    expect(dispatcher.dispatch({ key: "x", ctrlKey: true })).toBe(false);
  });
});
