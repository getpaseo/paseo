import { describe, expect, it } from "vitest";
import { createPluginDaemonTransportFactory } from "./daemon-transport.js";
import type { PluginProcessMessage, PluginProcessRequest } from "./plugin-process-protocol.js";

describe("plugin daemon IPC transport", () => {
  it("preserves incoming text and binary frame order", async () => {
    let receive: ((message: PluginProcessRequest) => void) | null = null;
    const sent: PluginProcessMessage[] = [];
    const factory = createPluginDaemonTransportFactory({
      send(message) {
        sent.push(message);
      },
      onMessage(handler) {
        receive = handler;
        return () => {
          receive = null;
        };
      },
    });
    const transport = factory({ url: "ipc://plugin" });
    const frames: Array<{ data: unknown; isBinary: boolean }> = [];
    transport.onMessage((data, isBinary) => frames.push({ data, isBinary }));
    const opened = new Promise<void>((resolve) => transport.onOpen(resolve));

    await opened;
    receive?.({ type: "paseo_frame", data: "first", isBinary: false });
    receive?.({ type: "paseo_frame", data: new Uint8Array([7, 8]), isBinary: true });
    transport.send("outbound");

    expect(frames).toEqual([
      { data: "first", isBinary: false },
      { data: new Uint8Array([7, 8]), isBinary: true },
    ]);
    expect(sent).toEqual([{ type: "paseo_frame", data: "outbound", isBinary: false }]);
  });
});
