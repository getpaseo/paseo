import { describe, expect, it } from "vitest";
import { createReadingSignal } from "./reading-signal";

describe("createReadingSignal", () => {
  it("notifies subscribers only when the value changes", () => {
    const signal = createReadingSignal<number | null>(null);
    let notifications = 0;
    const unsubscribe = signal.subscribe(() => {
      notifications += 1;
    });

    signal.publish(9);
    signal.publish(9);
    signal.publish(20);
    unsubscribe();
    signal.publish(null);

    expect(notifications).toBe(2);
    expect(signal.getValue()).toBeNull();
  });

  it("starts at the initial value and notifies every subscriber", () => {
    const signal = createReadingSignal<string | null>(null);
    const seen: string[] = [];
    signal.subscribe(() => seen.push("first"));
    signal.subscribe(() => seen.push("second"));

    expect(signal.getValue()).toBeNull();
    signal.publish("item-3");

    expect(seen).toEqual(["first", "second"]);
    expect(signal.getValue()).toBe("item-3");
  });
});
