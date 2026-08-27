import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopHostBridge } from "@/desktop/host";
import { mountBrowserScreencastForwarder } from "./host-frames";

type FramePayload = Parameters<
  Parameters<typeof mountBrowserScreencastForwarder>[0]["sendBrowserScreencastFrame"]
>[0];

function hostEmitting(): {
  host: () => DesktopHostBridge;
  emit: (payload: unknown) => void;
} {
  let listener: ((payload: unknown) => void) | null = null;
  const bridge = {
    events: {
      on: (_channel: string, handler: (payload: unknown) => void) => {
        listener = handler;
        return () => {
          listener = null;
        };
      },
    },
  } as unknown as DesktopHostBridge;
  return { host: () => bridge, emit: (payload) => listener?.(payload) };
}

const VALID = {
  slot: 3,
  metadata: { deviceWidth: 1280, deviceHeight: 800 },
  data: new Uint8Array([1, 2, 3]),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mountBrowserScreencastForwarder", () => {
  it("forwards a well-formed host frame to the daemon", async () => {
    const sent: FramePayload[] = [];
    const { host, emit } = hostEmitting();
    mountBrowserScreencastForwarder({ sendBrowserScreencastFrame: (f) => sent.push(f) }, host);
    await Promise.resolve();

    emit(VALID);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.slot).toBe(3);
  });

  it("reports a malformed frame instead of dropping it silently", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: FramePayload[] = [];
    const { host, emit } = hostEmitting();
    mountBrowserScreencastForwarder({ sendBrowserScreencastFrame: (f) => sent.push(f) }, host);
    await Promise.resolve();

    // `data` arriving as anything but a Uint8Array is the failure that leaves a
    // viewer staring at a frozen mirror with no error anywhere.
    emit({ ...VALID, data: "not-bytes" });

    expect(sent).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("dropped malformed host frame");
  });
});
