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

it("charges queued ASCII messages by their UTF-8 bytes", async () => {
  let drain!: () => void;
  let blocked = true;
  const transport = new ChunkedTransport({
    frameBytes: 32 * 1024 * 1024,
    send: () => {
      if (blocked) {
        blocked = false;
        return new Promise<void>((resolve) => {
          drain = resolve;
        });
      }
    },
    deliver: () => {},
  });
  transport.enabled = true;
  const first = transport.send(new Uint8Array([1]));
  const text = "x".repeat(10 * 1024 * 1024);
  const queued = Array.from({ length: 4 }, () => transport.send(text));
  const settled = Promise.allSettled(queued);
  expect(transport.queuedByteLength).toBe(40 * 1024 * 1024);
  drain();
  await first;
  expect((await settled).map((result) => result.status)).toEqual([
    "fulfilled",
    "fulfilled",
    "fulfilled",
    "fulfilled",
  ]);
});

it("notifies the socket owner when an awaited send overflows the queue", async () => {
  let drain!: () => void;
  const failures: unknown[] = [];
  const transport = new ChunkedTransport({
    frameBytes: 32 * 1024 * 1024,
    send: () =>
      new Promise<void>((resolve) => {
        drain = resolve;
      }),
    deliver: () => {},
    onFailure: (error) => {
      failures.push(error);
    },
  });
  const first = transport.send(new Uint8Array(100 * 1024 * 1024));
  const overflow = transport.send("extra");
  await expect(overflow).rejects.toThrow("queue");
  drain();
  await first;
  expect(failures).toHaveLength(1);
});

it("bounds retained reassembly memory for many one-byte chunks", async () => {
  const { spawnSync } = await import("node:child_process");
  // Exercise the built package as a Node consumer; CI builds it before protocol tests.
  const entry = new URL("../dist/chunked-transport.js", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      "--input-type=module",
      "-e",
      `
    import { ChunkedTransport } from ${JSON.stringify(entry)};
    let delivered = 0;
    const receiver = new ChunkedTransport({ frameBytes: 8, send() {}, deliver(frame) { delivered = frame.byteLength; } });
    receiver.enabled = true;
    global.gc();
    const before = process.memoryUsage().heapUsed;
    receiver.receive(new Uint8Array([0x31, 1, 1, 1, 65]));
    for (let index = 0; index < 300000; index++) receiver.receive(new Uint8Array([0x31, 1, 1, 0, 65]));
    global.gc();
    const growth = process.memoryUsage().heapUsed - before;
    receiver.receive(new Uint8Array([0x31, 1, 1, 2, 66]));
    console.log(JSON.stringify({ growth, delivered }));
  `,
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  expect(result.status, result.stderr).toBe(0);
  const observed = JSON.parse(result.stdout);
  expect(observed.delivered).toBe(300002);
  expect(observed.growth).toBeLessThan(8 * 1024 * 1024);
}, 20000);

it.each(["ASCII", "中", "🌍", "\ud800", "\udc00", "\ud800x"])(
  "accounts for queued UTF-8 text %j exactly",
  async (text) => {
    let drain!: () => void;
    let blocked = true;
    const transport = new ChunkedTransport({
      frameBytes: 1024,
      send: () => {
        if (blocked) {
          blocked = false;
          return new Promise<void>((resolve) => {
            drain = resolve;
          });
        }
      },
      deliver: () => {},
    });
    const first = transport.send(new Uint8Array([1]));
    const second = transport.send(text);
    expect(transport.queuedByteLength).toBe(new TextEncoder().encode(text).byteLength);
    drain();
    await Promise.all([first, second]);
  },
);

it("notifies the owner once when an accepted writer fails", async () => {
  const failures: unknown[] = [];
  const error = new Error("write failed");
  const transport = new ChunkedTransport({
    frameBytes: 1024,
    deliver: () => {},
    onFailure: (failure) => {
      failures.push(failure);
    },
    send: () => Promise.reject(error),
  });
  await expect(transport.send("hello", { waitForDrain: true })).rejects.toThrow("write failed");
  expect(failures).toEqual([error]);
  expect(() => transport.send("again")).toThrow("Transport closed");
  expect(failures).toEqual([error]);
});

it.each([false, true])(
  "a pre-write rejection preserves the sender (chunked=%s)",
  async (chunked) => {
    const failures: unknown[] = [];
    let reject = true;
    const transport = new ChunkedTransport({
      frameBytes: 8,
      deliver: () => {},
      onFailure: (error) => {
        failures.push(error);
      },
      send: () => {
        if (reject) throw new Error("capacity");
      },
    });
    transport.enabled = chunked;
    expect(() => transport.send("abcdefghij")).toThrow("capacity");
    expect(failures).toEqual([]);
    reject = false;
    await transport.send("sibling");
  },
);

it("a queued pre-write rejection does not poison the next logical send", async () => {
  let drain!: () => void;
  const failures: unknown[] = [];
  const delivered: string[] = [];
  const transport = new ChunkedTransport({
    frameBytes: 1024,
    deliver: () => {},
    onFailure: (error) => {
      failures.push(error);
    },
    send: (frame) => {
      if (frame === "blocked")
        return new Promise<void>((resolve) => {
          drain = resolve;
        });
      if (frame === "reject") throw new Error("capacity");
      delivered.push(frame as string);
    },
  });
  const first = transport.send("blocked");
  const rejected = transport.send("reject");
  const sibling = transport.send("sibling");
  const results = Promise.allSettled([first, rejected, sibling]);
  drain();
  expect((await results).map((result) => result.status)).toEqual([
    "fulfilled",
    "rejected",
    "fulfilled",
  ]);
  expect(delivered).toEqual(["sibling"]);
  expect(failures).toEqual([]);
});

it.each([false, true])("delivery errors leave framing usable (chunked=%s)", async (chunked) => {
  let fail = true;
  const delivered: (string | Uint8Array)[] = [];
  const transport = new ChunkedTransport({
    frameBytes: 64,
    send: () => {},
    deliver: (frame) => {
      if (fail) throw new Error("listener failed");
      delivered.push(frame);
    },
  });
  transport.enabled = chunked;
  const frame = chunked ? new Uint8Array([0x31, 1, 0, 3, 65]) : "A";
  expect(() => transport.receive(frame)).toThrow("listener failed");
  fail = false;
  transport.receive(frame);
  expect(delivered).toEqual(["A"]);
  await transport.send("still connected");
});

it("unpaced transports retain ordinary outbound admission and accept inbound chunks", async () => {
  const frames: unknown[] = [];
  const delivered: unknown[] = [];
  const transport = new ChunkedTransport({
    frameBytes: 8,
    supportsDrain: false,
    send: (frame) => {
      frames.push(frame);
      if (typeof frame === "string" && frame.length > 8) throw new Error("single frame limit");
    },
    deliver: (frame) => {
      delivered.push(frame);
    },
  });
  transport.enabled = true;
  expect(() => transport.send("too large for one frame")).toThrow("single frame limit");
  expect(frames).toEqual(["too large for one frame"]);
  transport.receive(new Uint8Array([0x31, 1, 0, 3, 65]));
  expect(delivered).toEqual(["A"]);
  await transport.send("small");
});
