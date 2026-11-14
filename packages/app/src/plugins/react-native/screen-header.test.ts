import { describe, expect, it, vi } from "vitest";
import { createScreenHeaderSlot } from "./screen-header";

describe("createScreenHeaderSlot", () => {
  it("shows the last mounted entry and falls back when it leaves", () => {
    const slot = createScreenHeaderSlot();
    expect(slot.present()).toBe(false);
    expect(slot.content()).toBeNull();
    slot.set("a", "first");
    slot.set("b", "second");
    expect(slot.content()).toBe("second");
    // An update keeps an entry's place.
    slot.set("a", "first, updated");
    expect(slot.content()).toBe("second");
    slot.remove("b");
    expect(slot.content()).toBe("first, updated");
    slot.remove("a");
    expect(slot.present()).toBe(false);
    expect(slot.content()).toBeNull();
  });

  it("notifies on every update, and only on a real removal", () => {
    const slot = createScreenHeaderSlot();
    const listener = vi.fn();
    const unsubscribe = slot.subscribe(listener);
    slot.set("a", "one");
    slot.set("a", "two");
    expect(listener).toHaveBeenCalledTimes(2);
    slot.remove("missing");
    expect(listener).toHaveBeenCalledTimes(2);
    slot.remove("a");
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    slot.set("a", "three");
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
