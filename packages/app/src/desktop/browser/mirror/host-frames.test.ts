import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopHostBridge } from "@/desktop/host";
import { mountBrowserScreencastForwarder } from "./host-frames";

const VALID = {
  slot: 3,
  metadata: { deviceWidth: 1280, deviceHeight: 800 },
  data: new Uint8Array([1, 2, 3]),
};

function setup() {
  let listener: (payload: unknown) => void = () => {};
  const host = () =>
    ({
      events: {
        on: (_channel: string, handler: (payload: unknown) => void) => {
          listener = handler;
          return () => {};
        },
      },
    }) as unknown as DesktopHostBridge;
  const sent: unknown[] = [];
  mountBrowserScreencastForwarder(
    { sendBrowserScreencastFrame: (frame) => sent.push(frame) },
    host,
  );
  return { emit: (payload: unknown) => listener(payload), sent };
}

afterEach(() => vi.restoreAllMocks());

describe("mountBrowserScreencastForwarder", () => {
  it("forwards valid host frames", async () => {
    const { emit, sent } = setup();
    await Promise.resolve();
    emit(VALID);
    expect(sent).toEqual([VALID]);
  });

  it("reports and drops malformed host frames", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { emit, sent } = setup();
    await Promise.resolve();
    emit({ ...VALID, data: "not-bytes" });
    expect(sent).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("dropped malformed host frame"),
      expect.any(Array),
    );
  });
});
