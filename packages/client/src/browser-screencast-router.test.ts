import { BrowserScreencastOpcode } from "@getpaseo/protocol/binary-frames/index";
import { describe, expect, test } from "vitest";
import {
  BrowserScreencastRouter,
  type BrowserScreencastEvent,
} from "./browser-screencast-router.js";

const METADATA = { deviceWidth: 1280, deviceHeight: 800 };
const PAYLOAD = new TextEncoder().encode("jpeg");
const frame = (slot: number) => ({
  opcode: BrowserScreencastOpcode.Frame,
  slot,
  metadata: METADATA,
  payload: PAYLOAD,
});
const setup = () => {
  const router = new BrowserScreencastRouter();
  const events: BrowserScreencastEvent[] = [];
  router.onEvent((event) => events.push(event));
  return { router, events };
};

describe("browser-screencast-router", () => {
  test("routes only frames whose slot is assigned", () => {
    const { router, events } = setup();
    router.setSlot("browser-1", 7);
    router.handleFrame(frame(3));
    router.handleFrame(frame(7));
    expect(events).toEqual([{ browserId: "browser-1", metadata: METADATA, data: PAYLOAD }]);
  });

  test("a reassigned slot routes only to its new browser", () => {
    const { router, events } = setup();
    router.setSlot("browser-1", 4);
    router.setSlot("browser-2", 4);
    router.handleFrame(frame(4));
    expect(events.map((event) => event.browserId)).toEqual(["browser-2"]);
  });

  test("one listener throwing does not block the rest", () => {
    const router = new BrowserScreencastRouter();
    const reached: string[] = [];
    router.setSlot("browser-1", 0);
    router.onEvent(() => {
      throw new Error("pane blew up");
    });
    router.onEvent(() => reached.push("second"));
    router.handleFrame(frame(0));
    expect(reached).toEqual(["second"]);
  });
});
