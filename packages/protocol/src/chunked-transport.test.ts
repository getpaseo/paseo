import { describe, expect, it } from "vitest";
import { ChunkedTransport } from "./chunked-transport.js";

describe("chunked transport", () => {
  it("delivers a large UTF-8 logical message once, preserving order", async () => {
    const delivered: (string | Uint8Array)[] = [];
    const receiver = new ChunkedTransport({
      frameBytes: 17,
      send: () => {},
      deliver: (v) => delivered.push(v),
    });
    receiver.enabled = true;
    const frames: (string | Uint8Array)[] = [];
    const sender = new ChunkedTransport({
      frameBytes: 17,
      send: (v) => {
        frames.push(v);
        receiver.receive(v);
      },
      deliver: () => {},
    });
    sender.enabled = true;
    const text = "🌍".repeat(100);
    await sender.send(text);
    expect(delivered).toEqual([text]);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((v) => v instanceof Uint8Array && v.byteLength <= 17)).toBe(true);
  });
});

it("preserves binary kind and leaves legacy frames unchanged", async () => {
  const delivered: (string | Uint8Array)[] = [];
  const receiver = new ChunkedTransport({
    frameBytes: 8,
    send: () => {},
    deliver: (v) => delivered.push(v),
  });
  const frames: (string | Uint8Array)[] = [];
  const sender = new ChunkedTransport({
    frameBytes: 8,
    send: (v) => {
      frames.push(v);
      receiver.receive(v);
    },
    deliver: () => {},
  });
  const data = new Uint8Array(40).fill(5);
  await sender.send(data);
  expect(frames).toEqual([data]);
  frames.length = 0;
  sender.enabled = receiver.enabled = true;
  await sender.send(data);
  expect(frames).toHaveLength(10);
  expect(delivered).toEqual([data, data]);
});

it("rejects malformed sequences and drops incomplete transfers on close", () => {
  const delivered: unknown[] = [];
  const receiver = new ChunkedTransport({
    frameBytes: 8,
    send: () => {},
    deliver: (v) => delivered.push(v),
  });
  receiver.enabled = true;
  receiver.receive(new Uint8Array([0x31, 1, 0, 1, 65]));
  expect(() => receiver.receive("interrupted")).toThrow("Interrupted");
  receiver.receive(new Uint8Array([0x31, 1, 0, 2, 66]));
  expect(delivered).toEqual([]);
});

it("waits for drain before the next chunk and preserves logical ordering", async () => {
  const frames: (string | Uint8Array)[] = [];
  let drain!: () => void;
  const sender = new ChunkedTransport({
    frameBytes: 8,
    send: (v) => {
      frames.push(v);
      if (frames.length === 1)
        return new Promise<void>((resolve) => {
          drain = resolve;
        });
    },
    deliver: () => {},
  });
  sender.enabled = true;
  const first = sender.send("abcdefghij");
  const next = new Uint8Array([1, 2, 3, 4]);
  const second = sender.send(next);
  await Promise.resolve();
  expect(frames).toHaveLength(1);
  expect(sender.queuedByteLength).toBe(4);
  drain();
  await Promise.all([first, second]);
  expect(frames).toHaveLength(4);
  expect(frames[3]).toEqual(next);
  expect(sender.queuedByteLength).toBe(0);
});

it.each([
  [0x31, 2, 0, 3, 65],
  [0x31, 1, 2, 3, 65],
  [0x31, 1, 0, 4, 65],
  [0x31, 1, 0, 2, 65],
  [0x31, 1, 0, 1],
])("rejects malformed chunk metadata %j", (...bytes) => {
  const receiver = new ChunkedTransport({
    frameBytes: 8,
    send: () => {},
    deliver: () => {
      throw new Error("Unexpected delivery");
    },
  });
  receiver.enabled = true;
  expect(() => receiver.receive(new Uint8Array(bytes))).toThrow();
});

it("reconnect discards partial state and requires negotiation again", () => {
  const delivered: unknown[] = [];
  const create = () =>
    new ChunkedTransport({ frameBytes: 8, send: () => {}, deliver: (v) => delivered.push(v) });
  const old = create();
  old.enabled = true;
  old.receive(new Uint8Array([0x31, 1, 0, 1, 65]));
  old.close();
  old.receive(new Uint8Array([0x31, 1, 0, 2, 66]));
  const fresh = create();
  expect(fresh.enabled).toBe(false);
  fresh.enabled = true;
  fresh.receive(new Uint8Array([0x31, 1, 0, 3, 67]));
  expect(delivered).toEqual(["C"]);
});

it("bounds logical messages waiting behind a blocked writer", async () => {
  let drain!: () => void;
  const transport = new ChunkedTransport({
    frameBytes: 32 * 1024 * 1024,
    send: () =>
      new Promise<void>((resolve) => {
        drain = resolve;
      }),
    deliver: () => {},
  });
  const first = transport.send(new Uint8Array(100 * 1024 * 1024));
  const overflow = transport.send("one more byte");
  try {
    await expect(overflow).rejects.toThrow("queue");
  } finally {
    drain();
    await first;
  }
});

it("requests drain for chunks while ordinary frames keep the immediate write path", async () => {
  const waits: boolean[] = [];
  const transport = new ChunkedTransport({
    frameBytes: 8,
    send: (_frame, wait) => {
      waits.push(wait);
    },
    deliver: () => {},
  });
  transport.enabled = true;
  await transport.send("small");
  await transport.send("abcdefghij");
  expect(waits).toEqual([false, true, true, true]);
});
