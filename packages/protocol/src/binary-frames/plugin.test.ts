import { describe, expect, it } from "vitest";

import {
  assertPluginWireValue,
  decodeBinaryFrame,
  decodePluginFrame,
  encodePluginEventFrame,
  encodePluginInputFrame,
  encodePluginOutputFrame,
  FileTransferOpcode,
  MAX_PLUGIN_PAYLOAD_BYTES,
  MAX_ROUTED_PAYLOAD_BYTES,
  PluginFrameOpcode,
  TerminalStreamOpcode,
} from "./index.js";

describe("plugin binary frames", () => {
  it("uses the reserved plugin opcode range", () => {
    for (const opcode of Object.values(PluginFrameOpcode)) {
      expect(opcode).toBeGreaterThanOrEqual(0x20);
      expect(opcode).toBeLessThanOrEqual(0x2f);
      expect(Object.values(TerminalStreamOpcode)).not.toContain(opcode);
      expect(Object.values(FileTransferOpcode)).not.toContain(opcode);
    }
  });

  it("frames a subscription event as opcode, id length, id, and the untouched payload", () => {
    const payload = new Uint8Array([9, 8, 7]);
    const frame = encodePluginEventFrame("sub-1", payload);
    expect([...frame]).toEqual([0x20, 5, ...new TextEncoder().encode("sub-1"), 9, 8, 7]);
    expect(decodeBinaryFrame(frame)).toEqual({
      kind: "plugin",
      frame: { opcode: PluginFrameOpcode.Event, subscriptionId: "sub-1", payload },
    });
  });

  it("decodes payloads as views into the received buffer", () => {
    const frame = encodePluginOutputFrame("req-1", new Uint8Array([1, 2, 3, 4]));
    const decoded = decodePluginFrame(frame);
    if (decoded?.opcode !== PluginFrameOpcode.Output) throw new Error("Expected an output frame");
    expect(decoded.requestId).toBe("req-1");
    expect(decoded.payload.buffer).toBe(frame.buffer);
    expect([...decoded.payload]).toEqual([1, 2, 3, 4]);
  });

  it("frames an RPC input with the plugin and method in its header", () => {
    const frame = encodePluginInputFrame({
      requestId: "req-2",
      pluginId: "uploads",
      method: "upload.store",
      payload: new Uint8Array([5, 6]),
    });
    expect(decodePluginFrame(frame)).toEqual({
      opcode: PluginFrameOpcode.Input,
      requestId: "req-2",
      pluginId: "uploads",
      method: "upload.store",
      payload: new Uint8Array([5, 6]),
    });
  });

  it("rejects truncated frames", () => {
    expect(decodePluginFrame(new Uint8Array([0x20]))).toBeNull();
    expect(decodePluginFrame(new Uint8Array([0x20, 9, 1]))).toBeNull();
    expect(decodePluginFrame(new Uint8Array([0x22, 1, 65, 0, 40]))).toBeNull();
  });
});

describe("the plugin byte rule", () => {
  it("accepts JSON values and a top-level Uint8Array", () => {
    expect(() => assertPluginWireValue({ a: [1, "b", null] }, "event")).not.toThrow();
    expect(() => assertPluginWireValue(new Uint8Array(4), "event")).not.toThrow();
  });

  it("rejects bytes that would not fit in one frame with the largest header", () => {
    const bytes = new Uint8Array(MAX_PLUGIN_PAYLOAD_BYTES + 1);
    expect(() => assertPluginWireValue(bytes.subarray(1), "event")).not.toThrow();
    expect(() => assertPluginWireValue(bytes, "event")).toThrow(
      `event is ${MAX_PLUGIN_PAYLOAD_BYTES + 1} bytes; one value carries at most ${MAX_PLUGIN_PAYLOAD_BYTES} bytes`,
    );
    const frame = encodePluginInputFrame({
      requestId: "r".repeat(255),
      pluginId: "p",
      method: "m".repeat(0xffff - 30),
      payload: bytes.subarray(1),
    });
    expect(frame.byteLength).toBeLessThanOrEqual(MAX_ROUTED_PAYLOAD_BYTES);
  });

  it("rejects bytes nested in a value and names the rule and the path", () => {
    expect(() => assertPluginWireValue({ frames: [{ data: new Uint8Array(1) }] }, "event")).toThrow(
      "event.frames[0].data is a Uint8Array. Bytes cross the wire only as the whole value: send the Uint8Array itself, or encode it into the value.",
    );
  });
});
