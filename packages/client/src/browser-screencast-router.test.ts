import { BrowserScreencastOpcode } from "@getpaseo/protocol/binary-frames/index";
import { describe, expect, test } from "vitest";

import {
  BrowserScreencastRouter,
  type BrowserScreencastEvent,
} from "./browser-screencast-router.js";

const METADATA = { deviceWidth: 1280, deviceHeight: 800 };

function frame(slot: number, payload: Uint8Array) {
  return { opcode: BrowserScreencastOpcode.Frame, slot, metadata: METADATA, payload };
}

describe("browser-screencast-router", () => {
  test("routes a frame to the browser holding its slot", () => {
    const router = new BrowserScreencastRouter();
    const events: BrowserScreencastEvent[] = [];
    const payload = new TextEncoder().encode("jpeg");

    router.setSlot("browser-1", 7);
    router.onEvent((event) => events.push(event));
    router.handleFrame(frame(7, payload));

    expect(events).toEqual([{ browserId: "browser-1", metadata: METADATA, data: payload }]);
  });

  test("drops a frame for a slot no browser holds", () => {
    const router = new BrowserScreencastRouter();
    const events: BrowserScreencastEvent[] = [];
    router.onEvent((event) => events.push(event));

    router.handleFrame(frame(3, new TextEncoder().encode("jpeg")));

    expect(events).toEqual([]);
  });

  test("reassigning a slot stops routing to the browser that had it", () => {
    const router = new BrowserScreencastRouter();
    const events: BrowserScreencastEvent[] = [];
    router.setSlot("browser-1", 4);
    router.setSlot("browser-2", 4);
    router.onEvent((event) => events.push(event));

    router.handleFrame(frame(4, new TextEncoder().encode("jpeg")));

    expect(events.map((event) => event.browserId)).toEqual(["browser-2"]);
  });

  test("one listener throwing does not stop the frame reaching the rest", () => {
    const router = new BrowserScreencastRouter();
    const reached: string[] = [];
    router.setSlot("browser-1", 0);
    router.onEvent(() => {
      throw new Error("pane blew up");
    });
    router.onEvent(() => reached.push("second"));

    router.handleFrame(frame(0, new TextEncoder().encode("jpeg")));

    expect(reached).toEqual(["second"]);
  });
});
