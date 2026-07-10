import { describe, expect, test } from "vitest";
import type { IsolatedKeyboardInputEvent } from "./trusted-input.js";
import { dispatchTrustedKey } from "./trusted-input.js";

describe("trusted browser input", () => {
  test.each([
    ["a", "a", ["keyDown", "char", "keyUp"]],
    ["Z", "Z", ["keyDown", "char", "keyUp"]],
    ["Space", "Space", ["keyDown", "keyUp"]],
    ["ArrowDown", "Down", ["keyDown", "keyUp"]],
  ])(
    "sends %s as Electron key code %s with unhandled redispatch disabled",
    (key, keyCode, types) => {
      const events: IsolatedKeyboardInputEvent[] = [];

      dispatchTrustedKey((event) => {
        events.push(event);
      }, key);

      expect(events).toEqual(
        types.map((type) => ({
          type,
          keyCode,
          skipIfUnhandled: true,
        })),
      );
    },
  );
});
