import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  decodeBrowserScreencastFrame,
  encodeBrowserScreencastAck,
  type BrowserScreencastBinaryFrame,
} from "@getpaseo/protocol/binary-frames/index";
import { createBrowserToolsRequestError } from "../../browser-tools/errors.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { ScreencastFrame } from "../../verify/playwright-host.js";
import { SessionDelivery } from "../owned-subscriptions/index.js";
import { BrowserScreencastSession, SCREENCAST_MAX_FPS, ScreencastPacer } from "./screencast.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ScreencastPacer", () => {
  function createPacer() {
    const sent: Array<{ frame: string; sequence: number }> = [];
    const pendingWrites: Array<() => void> = [];
    const pacer = new ScreencastPacer<string>({
      minIntervalMs: 100,
      maxUnacked: 2,
      send: (frame, sequence) => {
        sent.push({ frame, sequence });
        return new Promise((resolve) => pendingWrites.push(resolve));
      },
    });
    async function finishWrite() {
      pendingWrites.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
    }
    return { pacer, sent, finishWrite };
  }

  test("holds frames until resumed and then sends only the latest", () => {
    const { pacer, sent } = createPacer();
    pacer.push("a");
    pacer.push("b");
    expect(sent).toEqual([]);
    pacer.resume();
    expect(sent).toEqual([{ frame: "b", sequence: 1 }]);
  });

  test("replaces frames that arrive during a write and sends the newest after the interval", async () => {
    const { pacer, sent, finishWrite } = createPacer();
    pacer.resume();
    pacer.push("a");
    pacer.push("b");
    pacer.push("c");
    await finishWrite();
    expect(sent).toEqual([{ frame: "a", sequence: 1 }]);
    await vi.advanceTimersByTimeAsync(99);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([
      { frame: "a", sequence: 1 },
      { frame: "c", sequence: 2 },
    ]);
  });

  test("waits for the viewer's ack once two frames are unacknowledged", async () => {
    const { pacer, sent, finishWrite } = createPacer();
    pacer.resume();
    pacer.push("a");
    await finishWrite();
    await vi.advanceTimersByTimeAsync(100);
    pacer.push("b");
    await finishWrite();
    await vi.advanceTimersByTimeAsync(100);
    pacer.push("c");
    expect(sent.map((entry) => entry.frame)).toEqual(["a", "b"]);
    pacer.ack(5);
    expect(sent).toHaveLength(2);
    pacer.ack(1);
    expect(sent.map((entry) => entry.frame)).toEqual(["a", "b", "c"]);
  });

  test("caps a continuous stream at the configured rate", async () => {
    const sent: number[] = [];
    const pacer = new ScreencastPacer<number>({
      minIntervalMs: 100,
      maxUnacked: 2,
      send: async (_frame, sequence) => {
        sent.push(Date.now());
        queueMicrotask(() => pacer.ack(sequence));
      },
    });
    pacer.resume();
    const startedAt = Date.now();
    for (let elapsed = 0; elapsed < 1_000; elapsed += 10) {
      pacer.push(elapsed);
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(sent.map((at) => at - startedAt)).toEqual([
      0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1_000,
    ]);
  });

  test("drops the pending frame when stopped", async () => {
    const { pacer, sent, finishWrite } = createPacer();
    pacer.resume();
    pacer.push("a");
    await finishWrite();
    pacer.push("b");
    pacer.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent.map((entry) => entry.frame)).toEqual(["a"]);
  });
});

describe("BrowserScreencastSession", () => {
  interface FakeStream {
    browserId: string;
    onFrame: (frame: ScreencastFrame) => void;
    onEnd: () => void;
    stopped: boolean;
  }

  type WireEntry =
    | { kind: "json"; message: SessionOutboundMessage }
    | { kind: "binary"; frame: BrowserScreencastBinaryFrame };

  function frame(width: number): ScreencastFrame {
    return {
      dataBase64: Buffer.from([0xff, 0xd8, width & 0xff]).toString("base64"),
      width,
      height: 600,
    };
  }

  function setup() {
    const viewer = {};
    const wire: WireEntry[] = [];
    const streams: FakeStream[] = [];
    const delivery = new SessionDelivery(
      (_source, message) => wire.push({ kind: "json", message }),
      (_source, bytes) => {
        const decoded = decodeBrowserScreencastFrame(bytes);
        if (decoded) wire.push({ kind: "binary", frame: decoded });
      },
    );
    delivery.attach(viewer, true);
    const screencast = new BrowserScreencastSession({
      host: {
        startScreencast: async (input) => {
          if (input.browserId === "missing") {
            throw createBrowserToolsRequestError({
              code: "browser_tab_not_found",
              message: "Browser tab missing is not known to the daemon browser host.",
            });
          }
          const stream: FakeStream = { ...input, stopped: false };
          streams.push(stream);
          // Chrome sends its first frame while startScreencast is still resolving.
          input.onFrame(frame(800));
          return async () => {
            stream.stopped = true;
          };
        },
      },
      emit: (message) => {
        if (!delivery.reply(message)) wire.push({ kind: "json", message });
      },
    });

    function request(message: SessionInboundMessage, run: () => Promise<void>) {
      return delivery.request(viewer, message, run);
    }

    async function subscribe(browserId: string) {
      const message = {
        type: "browser.screencast.subscribe.request" as const,
        requestId: `req-${browserId}`,
        workspaceId: "wks",
        browserId,
      };
      await request(message, () => screencast.subscribe(message, delivery));
    }

    async function release(subscriptionId: string) {
      const message = {
        type: "subscription.release.request" as const,
        requestId: "req-release",
        subscriptionId,
      };
      await request(message, () => delivery.release(subscriptionId));
    }

    return { viewer, wire, streams, screencast, subscribe, release };
  }

  test("answers with a slot before the first frame and paces later frames on acks", async () => {
    const { viewer, wire, streams, screencast, subscribe } = setup();
    await subscribe("tab-1");

    expect(wire).toHaveLength(2);
    const [response, first] = wire;
    expect(response).toMatchObject({
      kind: "json",
      message: {
        type: "browser.screencast.subscribe.response",
        payload: { requestId: "req-tab-1", browserId: "tab-1", slot: 0, error: null },
      },
    });
    expect(first).toEqual({
      kind: "binary",
      frame: {
        opcode: 0x20,
        slot: 0,
        sequence: 1,
        width: 800,
        height: 600,
        payload: new Uint8Array([0xff, 0xd8, 800 & 0xff]),
      },
    });

    await vi.advanceTimersByTimeAsync(1000 / SCREENCAST_MAX_FPS);
    streams[0].onFrame(frame(801));
    await vi.advanceTimersByTimeAsync(1000 / SCREENCAST_MAX_FPS);
    streams[0].onFrame(frame(802));
    await vi.advanceTimersByTimeAsync(1000 / SCREENCAST_MAX_FPS);
    expect(wire.filter((entry) => entry.kind === "binary")).toHaveLength(2);

    const ack = decodeBrowserScreencastFrame(encodeBrowserScreencastAck({ slot: 0, sequence: 1 }));
    screencast.handleFrame(ack!, {});
    expect(wire.filter((entry) => entry.kind === "binary")).toHaveLength(2);
    screencast.handleFrame(ack!, viewer);
    const binary = wire.filter((entry) => entry.kind === "binary");
    expect(binary.at(-1)).toMatchObject({ frame: { sequence: 3, width: 802 } });
  });

  test("stops the tab screencast when the viewer releases its subscription", async () => {
    const { wire, streams, subscribe, release } = setup();
    await subscribe("tab-1");
    const response = wire[0];
    const subscriptionId =
      response.kind === "json" &&
      response.message.type === "browser.screencast.subscribe.response" &&
      response.message.payload.error === null
        ? response.message.payload.subscriptionId
        : "";

    await release(subscriptionId);

    expect(streams[0].stopped).toBe(true);
  });

  test("tells the viewer when the tab closes and stops streaming", async () => {
    const { wire, streams, subscribe } = setup();
    await subscribe("tab-1");

    streams[0].onEnd();
    await vi.advanceTimersByTimeAsync(0);

    expect(wire.at(-1)).toMatchObject({
      kind: "json",
      message: { type: "browser.screencast.ended", payload: { browserId: "tab-1" } },
    });
    expect(streams[0].stopped).toBe(true);
  });

  test("answers with the host's error for an unknown tab", async () => {
    const { wire, subscribe } = setup();
    await subscribe("missing");

    expect(wire).toEqual([
      {
        kind: "json",
        message: {
          type: "browser.screencast.subscribe.response",
          payload: {
            requestId: "req-missing",
            browserId: "missing",
            error: "Browser tab missing is not known to the daemon browser host.",
          },
        },
      },
    ]);
  });
});
