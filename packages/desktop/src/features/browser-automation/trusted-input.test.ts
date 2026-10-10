import { describe, expect, test } from "vitest";
import type { IsolatedKeyboardInputEvent } from "./trusted-input.js";
import { dispatchTrustedDrag, dispatchTrustedKey } from "./trusted-input.js";

describe("trusted browser input", () => {
  test.each([
    { interrupted: "press", release: { x: 20, y: 30 } },
    { interrupted: "midpoint", release: { x: 20, y: 30 } },
    { interrupted: "target", release: { x: 60, y: 70 } },
  ])(
    "cancelled drag at $interrupted releases at the last acknowledged point",
    async ({ interrupted, release }) => {
      const events: Record<string, unknown>[] = [];
      const expired = new Error("gesture expired");
      await expect(
        dispatchTrustedDrag(
          async (_command, params) => {
            const event = params ?? {};
            events.push(event);
            const pressing = event.type === "mousePressed";
            const moving = event.type === "mouseMoved" && event.buttons === 1;
            const interruptedPress = interrupted === "press" && pressing;
            const interruptedMove =
              moving && (interrupted === "midpoint" ? event.x === 60 : event.x === 100);
            if (interruptedPress || interruptedMove) throw expired;
            return {};
          },
          { x: 20, y: 30 },
          { x: 100, y: 110 },
        ),
      ).rejects.toBe(expired);
      expect(events.at(-1)).toMatchObject({ type: "mouseReleased", ...release, buttons: 0 });
      expect(events.filter((event) => event.type === "mouseReleased")).toHaveLength(1);
      expect(events.at(-1)?.x).not.toBe(100);
    },
  );

  test.each([
    ["a", "a", ["keyDown", "char", "keyUp"]],
    ["Z", "Z", ["keyDown", "char", "keyUp"]],
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

  test("inserts a named Space keypress", () => {
    const events: IsolatedKeyboardInputEvent[] = [];

    dispatchTrustedKey((event) => {
      events.push(event);
    }, "Space");

    expect(events).toEqual([
      { type: "keyDown", keyCode: "Space", skipIfUnhandled: true },
      { type: "char", keyCode: " ", skipIfUnhandled: true },
      { type: "keyUp", keyCode: "Space", skipIfUnhandled: true },
    ]);
  });
});
