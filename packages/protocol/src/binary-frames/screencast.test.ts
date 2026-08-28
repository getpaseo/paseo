import { describe, expect, it } from "vitest";
import { decodeBinaryFrame } from "./demux.js";
import {
  BrowserScreencastOpcode,
  decodeBrowserScreencastFrame,
  encodeBrowserScreencastFrame,
} from "./screencast.js";

const metadata = { deviceWidth: 1280, deviceHeight: 800 };
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03]);

describe("browser screencast frames", () => {
  it("round-trips a frame", () => {
    const decoded = decodeBrowserScreencastFrame(
      encodeBrowserScreencastFrame({ slot: 7, metadata, payload: jpeg }),
    );

    expect(decoded).toEqual({
      opcode: BrowserScreencastOpcode.Frame,
      slot: 7,
      metadata,
      payload: jpeg,
    });
  });

  it("round-trips an empty payload", () => {
    const decoded = decodeBrowserScreencastFrame(
      encodeBrowserScreencastFrame({ slot: 0, metadata, payload: new Uint8Array() }),
    );

    expect(decoded?.payload.byteLength).toBe(0);
  });

  it("routes through the binary frame demultiplexer", () => {
    const frame = encodeBrowserScreencastFrame({ slot: 3, metadata, payload: jpeg });

    expect(decodeBinaryFrame(frame)).toEqual({
      kind: "browser_screencast",
      frame: { opcode: BrowserScreencastOpcode.Frame, slot: 3, metadata, payload: jpeg },
    });
  });

  it("rejects a truncated frame", () => {
    const frame = encodeBrowserScreencastFrame({ slot: 1, metadata, payload: jpeg });

    expect(decodeBrowserScreencastFrame(frame.subarray(0, 3))).toBeNull();
    expect(decodeBrowserScreencastFrame(frame.subarray(0, 6))).toBeNull();
  });

  it("rejects a frame whose metadata is not valid", () => {
    const frame = encodeBrowserScreencastFrame({
      slot: 1,
      metadata: { deviceWidth: 0, deviceHeight: 800 },
      payload: jpeg,
    });

    expect(decodeBrowserScreencastFrame(frame)).toBeNull();
  });
});
