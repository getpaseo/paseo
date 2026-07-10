import { describe, expect, test } from "vitest";
import type { IsolatedKeyboardInputEvent } from "./trusted-input.js";
import { dispatchTrustedKey } from "./trusted-input.js";

describe("trusted browser input", () => {
  test.each([
    ["a", "a"],
    ["Z", "Z"],
    ["Space", "Space"],
    ["ArrowDown", "Down"],
  ])("sends %s as Electron key code %s with unhandled redispatch disabled", (key, keyCode) => {
    const events: IsolatedKeyboardInputEvent[] = [];

    dispatchTrustedKey((event) => {
      events.push(event);
    }, key);

    expect(events).toEqual([
      {
        type: "keyDown",
        keyCode,
        skipIfUnhandled: true,
      },
      {
        type: "keyUp",
        keyCode,
        skipIfUnhandled: true,
      },
    ]);
  });
});
