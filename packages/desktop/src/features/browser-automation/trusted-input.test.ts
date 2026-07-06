import { describe, expect, test } from "vitest";
import { dispatchTrustedKey } from "./trusted-input.js";

describe("trusted browser input", () => {
  test("Space dispatches a real space key event", async () => {
    const commands: Array<{ command: string; params?: Record<string, unknown> }> = [];

    await dispatchTrustedKey(async (command, params) => {
      commands.push({ command, ...(params ? { params } : {}) });
      return {};
    }, "Space");

    expect(commands).toEqual([
      {
        command: "Input.dispatchKeyEvent",
        params: {
          type: "keyDown",
          key: " ",
          code: "Space",
          windowsVirtualKeyCode: 32,
          nativeVirtualKeyCode: 32,
          text: " ",
          unmodifiedText: " ",
        },
      },
      {
        command: "Input.dispatchKeyEvent",
        params: {
          type: "keyUp",
          key: " ",
          code: "Space",
          windowsVirtualKeyCode: 32,
          nativeVirtualKeyCode: 32,
        },
      },
    ]);
  });
});
