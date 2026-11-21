import net from "node:net";
import { describe, expect, it } from "vitest";
import { MAX_CHUNK_BYTES } from "../../../../../plugin-examples/browser-serial/shared/bridge";
import {
  type BridgeClock,
  SerialBridge,
} from "../../../../../plugin-examples/browser-serial/server/bridge";

// Deterministic clock: no global mocks or fake timers.
class FakeClock implements BridgeClock {
  time = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();

  now = (): number => this.time;

  setTimeout = (callback: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  };

  clearTimeout = (id: unknown): void => {
    this.timers.delete(id as number);
  };

  get pendingTimers(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      let best: number | null = null;
      let bestAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= end && timer.at < bestAt) {
          best = id;
          bestAt = timer.at;
        }
      }
      if (best === null) break;
      const timer = this.timers.get(best);
      if (!timer) break;
      this.timers.delete(best);
      this.time = timer.at;
      timer.callback();
    }
    this.time = end;
  }
}

function randomBytes(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  let seed = 0x12345678;
  for (let i = 0; i < length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = seed % 256;
  }
  bytes[0] = 0x00;
  if (length > 1) bytes[1] = 0xff;
  if (length > 2) bytes[2] = 0x80;
  return bytes;
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.off("error", reject);
      socket.on("error", () => {});
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function readBytes(socket: net.Socket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const onData = (data: Buffer) => {
      chunks.push(data);
      received += data.length;
      if (received >= length) {
        socket.off("data", onData);
        resolve(Buffer.concat(chunks, received).subarray(0, length));
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("Socket closed while reading.")));
  });
}

async function dispose(bridge: SerialBridge, sockets: net.Socket[]): Promise<void> {
  bridge.dispose();
  for (const socket of sockets) socket.destroy();
}

describe("browser serial example bridge", () => {
  it("forwards browser bytes to the host byte-exact, including non-UTF8", async () => {
    const bridge = new SerialBridge();
    const sockets: net.Socket[] = [];
    try {
      const { token, port } = await bridge.create();
      const socket = await connect(port);
      sockets.push(socket);
      const payload = randomBytes(MAX_CHUNK_BYTES + 17);
      const received = readBytes(socket, payload.length);
      for (let offset = 0; offset < payload.length; offset += MAX_CHUNK_BYTES) {
        await bridge.write(
          token,
          payload.subarray(offset, offset + MAX_CHUNK_BYTES).toString("base64"),
        );
      }
      expect(await received).toEqual(payload);
    } finally {
      await dispose(bridge, sockets);
    }
  });

  it("delivers host bytes to polls byte-exact, including non-UTF8", async () => {
    const bridge = new SerialBridge();
    const sockets: net.Socket[] = [];
    try {
      const { token, port } = await bridge.create();
      const socket = await connect(port);
      sockets.push(socket);
      const payload = randomBytes(5000);
      socket.write(payload);
      const first = await bridge.poll(token);
      expect(first.closed).toBe(false);
      expect(first.connected).toBe(true);
      expect(Buffer.from(first.data, "base64")).toEqual(payload);
    } finally {
      await dispose(bridge, sockets);
    }
  });

  it("buffers browser bytes before the host connects and flushes in order", async () => {
    const bridge = new SerialBridge();
    const sockets: net.Socket[] = [];
    try {
      const { token, port } = await bridge.create();
      const banner = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x0d, 0x0a]);
      const rest = randomBytes(100);
      await bridge.write(token, banner.toString("base64"));
      await bridge.write(token, rest.toString("base64"));
      const socket = await connect(port);
      sockets.push(socket);
      expect(await readBytes(socket, banner.length + rest.length)).toEqual(
        Buffer.concat([banner, rest]),
      );
    } finally {
      await dispose(bridge, sockets);
    }
  });

  it("rejects a duplicate bridge until the first one closes", async () => {
    const bridge = new SerialBridge();
    try {
      const { token } = await bridge.create();
      await expect(bridge.create()).rejects.toThrow("already active");
      await bridge.close(token);
      const second = await bridge.create();
      expect(second.token).not.toBe(token);
      await bridge.close(second.token);
    } finally {
      bridge.dispose();
    }
  });

  it("isolates tokens: wrong tokens fail without touching the bridge", async () => {
    const bridge = new SerialBridge();
    const sockets: net.Socket[] = [];
    try {
      const { token, port } = await bridge.create();
      await expect(bridge.poll("wrong")).rejects.toThrow("Unknown bridge token");
      await expect(bridge.renew("wrong")).rejects.toThrow("Unknown bridge token");
      await expect(bridge.write("wrong", "")).rejects.toThrow("Unknown bridge token");
      await expect(bridge.close("wrong")).rejects.toThrow("Unknown bridge token");
      const socket = await connect(port);
      sockets.push(socket);
      const pending = bridge.poll(token);
      socket.write(Buffer.from([1, 2, 3]));
      const result = await pending;
      expect(result.closed).toBe(false);
      expect(Buffer.from(result.data, "base64")).toEqual(Buffer.from([1, 2, 3]));
      await bridge.close(token);
    } finally {
      await dispose(bridge, sockets);
    }
  });

  it("rejects overlapping polls", async () => {
    const bridge = new SerialBridge();
    try {
      const { token } = await bridge.create();
      const first = bridge.poll(token);
      await expect(bridge.poll(token)).rejects.toThrow("already pending");
      await bridge.close(token);
      expect(await first).toMatchObject({ closed: true });
    } finally {
      bridge.dispose();
    }
  });

  it("resolves an idle poll empty after the poll timeout", async () => {
    const bridge = new SerialBridge({ pollTimeoutMs: 30 });
    try {
      const { token } = await bridge.create();
      const result = await bridge.poll(token);
      expect(result).toEqual({ data: "", connected: false, closed: false });
    } finally {
      bridge.dispose();
    }
  });

  it("rejects a second TCP client without disturbing the first", async () => {
    const bridge = new SerialBridge();
    const sockets: net.Socket[] = [];
    try {
      const { token, port } = await bridge.create();
      const first = await connect(port);
      sockets.push(first);
      const second = await connect(port);
      sockets.push(second);
      await new Promise<void>((resolve) => {
        if (second.destroyed) resolve();
        else second.once("close", () => resolve());
      });
      expect(second.destroyed).toBe(true);
      expect(first.destroyed).toBe(false);
      const received = readBytes(first, 3);
      await bridge.write(token, Buffer.from([9, 8, 7]).toString("base64"));
      expect(await received).toEqual(Buffer.from([9, 8, 7]));
    } finally {
      await dispose(bridge, sockets);
    }
  });

  it("rejects non-canonical and oversized base64", async () => {
    const bridge = new SerialBridge();
    try {
      const { token } = await bridge.create();
      for (const bad of ["====", "AB", "A B C D", "####", "a".repeat(43693)]) {
        await expect(bridge.write(token, bad)).rejects.toThrow("Invalid base64");
      }
      const oversized = Buffer.alloc(MAX_CHUNK_BYTES + 1, 0x41).toString("base64");
      await expect(bridge.write(token, oversized)).rejects.toThrow("Invalid base64");
      await bridge.write(token, "");
      await bridge.close(token);
    } finally {
      bridge.dispose();
    }
  });

  it("expires the lease without polls, even while host traffic continues", async () => {
    const clock = new FakeClock();
    const bridge = new SerialBridge({ clock, leaseMs: 20_000 });
    const sockets: net.Socket[] = [];
    try {
      const { token, port } = await bridge.create();
      const socket = await connect(port);
      sockets.push(socket);
      socket.write(Buffer.from([1]));
      clock.advance(20_000);
      const result = await bridge.poll(token).catch((error: Error) => error);
      expect(result instanceof Error || (result as { closed: boolean }).closed).toBe(true);
      expect(clock.pendingTimers).toBe(0);
    } finally {
      await dispose(bridge, sockets);
    }
  });

  it("renews the lease on polls, not writes, and clears timers on close", async () => {
    const clock = new FakeClock();
    const bridge = new SerialBridge({ clock, leaseMs: 20_000, pollTimeoutMs: 60_000 });
    try {
      const { token } = await bridge.create();
      clock.advance(15_000);
      await bridge.write(token, Buffer.from([1]).toString("base64"));
      clock.advance(5_000); // writes do not renew: lease started at create
      const expired = await bridge.poll(token).catch((error: Error) => error);
      expect(expired instanceof Error || (expired as { closed: boolean }).closed).toBe(true);

      const second = await bridge.create();
      clock.advance(15_000);
      const pending = bridge.poll(second.token); // poll renews the lease
      clock.advance(15_000);
      expect(clock.pendingTimers).toBeGreaterThan(0);
      await bridge.close(second.token);
      expect(await pending).toMatchObject({ closed: true });
      expect(clock.pendingTimers).toBe(0);
    } finally {
      bridge.dispose();
    }
  });

  it("renews the lease across the original deadline via renew", async () => {
    const clock = new FakeClock();
    const bridge = new SerialBridge({ clock, leaseMs: 20_000, pollTimeoutMs: 60_000 });
    try {
      const { token } = await bridge.create(); // lease expires at 20s
      clock.advance(15_000);
      await bridge.renew(token); // expiry moves to 35s
      clock.advance(15_000); // t=30s: past the original 20s deadline
      await expect(bridge.create()).rejects.toThrow("already active");
      await bridge.renew(token); // expiry moves to 50s
      clock.advance(19_000); // t=49s: still alive
      await expect(bridge.create()).rejects.toThrow("already active");
      clock.advance(1_000); // t=50s: renewed lease expires
      const expired = await bridge.poll(token).catch((error: Error) => error);
      expect(expired instanceof Error || (expired as { closed: boolean }).closed).toBe(true);
    } finally {
      bridge.dispose();
    }
  });

  it("rejects renew for invalid and closed tokens without touching the bridge", async () => {
    const clock = new FakeClock();
    const bridge = new SerialBridge({ clock, leaseMs: 20_000, pollTimeoutMs: 60_000 });
    try {
      const { token } = await bridge.create();
      clock.advance(15_000);
      await expect(bridge.renew("wrong")).rejects.toThrow("Unknown bridge token");
      clock.advance(5_000); // t=20s: invalid renew did not extend the lease
      const expired = await bridge.poll(token).catch((error: Error) => error);
      expect(expired instanceof Error || (expired as { closed: boolean }).closed).toBe(true);

      // A closed token renews nothing and never touches the next bridge.
      const second = await bridge.create();
      await bridge.close(second.token);
      await expect(bridge.renew(second.token)).rejects.toThrow("Unknown bridge token");
      const third = await bridge.create();
      clock.advance(15_000);
      await expect(bridge.renew(second.token)).rejects.toThrow("Unknown bridge token");
      await expect(bridge.renew("wrong")).rejects.toThrow("Unknown bridge token");
      clock.advance(5_000); // stale renews did not extend the third bridge
      const thirdExpired = await bridge.poll(third.token).catch((error: Error) => error);
      expect(thirdExpired instanceof Error || (thirdExpired as { closed: boolean }).closed).toBe(
        true,
      );
    } finally {
      bridge.dispose();
    }
  });

  it("expires a pending poll when the heartbeat stops", async () => {
    const clock = new FakeClock();
    const bridge = new SerialBridge({ clock, leaseMs: 20_000, pollTimeoutMs: 60_000 });
    try {
      const { token } = await bridge.create(); // t=0, lease to 20s
      const pending = bridge.poll(token); // parks until 60s
      clock.advance(5_000); // t=5s
      await bridge.renew(token); // heartbeat: lease to 25s
      clock.advance(5_000); // t=10s
      await bridge.renew(token); // lease to 30s
      clock.advance(5_000); // t=15s
      await bridge.renew(token); // lease to 35s
      clock.advance(19_000); // t=34s: past the original deadline, still alive
      await expect(bridge.create()).rejects.toThrow("already active");
      clock.advance(1_000); // t=35s: heartbeat stopped, lease fires
      expect(await pending).toMatchObject({ closed: true, connected: false });
      expect(clock.pendingTimers).toBe(0);
    } finally {
      bridge.dispose();
    }
  });

  it("does not renew the lease on a rejected overlapping poll", async () => {
    const clock = new FakeClock();
    const bridge = new SerialBridge({ clock, leaseMs: 20_000, pollTimeoutMs: 60_000 });
    try {
      const { token } = await bridge.create(); // t=0, lease to 20s
      clock.advance(15_000); // t=15s
      const pending = bridge.poll(token); // accepted: lease to 35s
      clock.advance(4_000); // t=19s
      await expect(bridge.poll(token)).rejects.toThrow("already pending");
      clock.advance(16_000); // t=35s: lease from the accepted poll expires
      expect(await pending).toMatchObject({ closed: true });
    } finally {
      bridge.dispose();
    }
  });

  it("closes on buffer overflow instead of dropping bytes", async () => {
    const bridge = new SerialBridge({ maxBufferedBytes: 64 });
    const sockets: net.Socket[] = [];
    try {
      const { token } = await bridge.create();
      await bridge.write(token, Buffer.alloc(64, 1).toString("base64"));
      await expect(bridge.write(token, Buffer.from([2]).toString("base64"))).rejects.toThrow(
        "overflow",
      );
      const after = await bridge.poll(token).catch((error: Error) => error);
      expect(after instanceof Error || (after as { closed: boolean }).closed).toBe(true);
    } finally {
      await dispose(bridge, sockets);
    }
  });

  it("closes on host-to-browser inbound overflow instead of dropping bytes", async () => {
    const bridge = new SerialBridge({ maxBufferedBytes: 64 });
    const sockets: net.Socket[] = [];
    try {
      const { token, port } = await bridge.create();
      const socket = await connect(port);
      sockets.push(socket);
      const closed = new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
      });
      socket.write(Buffer.alloc(65, 0x41));
      await closed;
      expect(socket.destroyed).toBe(true);
      await expect(bridge.poll(token)).resolves.toEqual({
        data: "",
        connected: false,
        closed: true,
      });
      await expect(bridge.write(token, Buffer.from([1]).toString("base64"))).rejects.toThrow(
        "Unknown bridge token",
      );
      // A fresh bridge works after the overflow close.
      const second = await bridge.create();
      await bridge.close(second.token);
    } finally {
      await dispose(bridge, sockets);
    }
  });

  it("closes on connected browser-to-host buffer overflow instead of dropping bytes", async () => {
    const bridge = new SerialBridge({ maxBufferedBytes: 64 });
    const sockets: net.Socket[] = [];
    try {
      const { token, port } = await bridge.create();
      const socket = await connect(port);
      sockets.push(socket);
      socket.write(Buffer.from([1]));
      const first = await bridge.poll(token);
      expect(first.connected).toBe(true);
      const closed = new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
      });
      await expect(bridge.write(token, Buffer.alloc(65, 0x41).toString("base64"))).rejects.toThrow(
        "Bridge write buffer overflow",
      );
      await closed;
      expect(socket.destroyed).toBe(true);
      await expect(bridge.poll(token)).resolves.toEqual({
        data: "",
        connected: false,
        closed: true,
      });
      // A fresh bridge works after the overflow close.
      const second = await bridge.create();
      await bridge.close(second.token);
    } finally {
      await dispose(bridge, sockets);
    }
  });

  it("hands off to a new client on the same endpoint when the host disconnects", async () => {
    const bridge = new SerialBridge();
    const sockets: net.Socket[] = [];
    try {
      const { token, port } = await bridge.create();
      const first = await connect(port);
      sockets.push(first);
      first.write(Buffer.from([1]));
      const synced = await bridge.poll(token);
      expect(synced.connected).toBe(true);
      const pending = bridge.poll(token);
      first.destroy();
      await expect(pending).resolves.toEqual({ data: "", connected: false, closed: false });
      await expect(bridge.create()).rejects.toThrow("already active");
      const second = await connect(port);
      sockets.push(second);
      second.write(Buffer.from([2]));
      const inbound = await bridge.poll(token);
      expect(inbound.connected).toBe(true);
      expect(Buffer.from(inbound.data, "base64")).toEqual(Buffer.from([2]));
      const received = readBytes(second, 3);
      await bridge.write(token, Buffer.from([9, 8, 7]).toString("base64"));
      expect(await received).toEqual(Buffer.from([9, 8, 7]));
      // Explicit close still ends the bridge even with an owner connected.
      const closed = new Promise<void>((resolve) => {
        second.once("close", () => resolve());
      });
      await bridge.close(token);
      await closed;
      await expect(bridge.poll(token)).resolves.toEqual({
        data: "",
        connected: false,
        closed: true,
      });
    } finally {
      await dispose(bridge, sockets);
    }
  });

  it("preserves FIFO order across repeated graceful handoffs", async () => {
    const bridge = new SerialBridge();
    const sockets: net.Socket[] = [];
    try {
      const { token, port } = await bridge.create();
      for (let round = 0; round < 3; round++) {
        const socket = await connect(port);
        sockets.push(socket);
        socket.write(Buffer.from([round]));
        const inbound = await bridge.poll(token);
        expect(inbound.connected).toBe(true);
        expect(Buffer.from(inbound.data, "base64")).toEqual(Buffer.from([round]));
        const received = readBytes(socket, 2);
        await bridge.write(token, Buffer.from([round, round]).toString("base64"));
        expect(await received).toEqual(Buffer.from([round, round]));
        const pending = bridge.poll(token);
        socket.destroy();
        await expect(pending).resolves.toEqual({ data: "", connected: false, closed: false });
      }
      // Bytes written during the gap buffer for the next owner, in order.
      await bridge.write(token, Buffer.from("gap").toString("base64"));
      const last = await connect(port);
      sockets.push(last);
      expect(await readBytes(last, 3)).toEqual(Buffer.from("gap"));
      await bridge.close(token);
    } finally {
      await dispose(bridge, sockets);
    }
  });

  it("explicitly releases the slot without ending the bridge", async () => {
    const bridge = new SerialBridge();
    const sockets: net.Socket[] = [];
    try {
      const { token, port } = await bridge.create();
      const socket = await connect(port);
      sockets.push(socket);
      socket.write(Buffer.from([1]));
      const synced = await bridge.poll(token);
      expect(synced.connected).toBe(true);
      const pending = bridge.poll(token);
      const closed = new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
      });
      await expect(bridge.release(token)).resolves.toEqual({});
      await closed;
      expect(socket.destroyed).toBe(true);
      await expect(pending).resolves.toEqual({ data: "", connected: false, closed: false });
      // Repeated release with no owner is a no-op success.
      await expect(bridge.release(token)).resolves.toEqual({});
      await expect(bridge.create()).rejects.toThrow("already active");
      const next = await connect(port);
      sockets.push(next);
      next.write(Buffer.from([2]));
      const inbound = await bridge.poll(token);
      expect(inbound.connected).toBe(true);
      expect(Buffer.from(inbound.data, "base64")).toEqual(Buffer.from([2]));
      await bridge.close(token);
    } finally {
      await dispose(bridge, sockets);
    }
  });

  it("rejects release for unknown tokens without touching the bridge", async () => {
    const bridge = new SerialBridge();
    const sockets: net.Socket[] = [];
    try {
      const { token, port } = await bridge.create();
      await expect(bridge.release("wrong")).rejects.toThrow("Unknown bridge token");
      const socket = await connect(port);
      sockets.push(socket);
      socket.write(Buffer.from([1]));
      const synced = await bridge.poll(token);
      expect(synced.connected).toBe(true);
      await bridge.close(token);
      // The most recently closed token succeeds without touching anything.
      await expect(bridge.release(token)).resolves.toEqual({});
      const second = await bridge.create();
      await expect(bridge.release(token)).resolves.toEqual({});
      const next = await connect(second.port);
      sockets.push(next);
      next.write(Buffer.from([2]));
      const inbound = await bridge.poll(second.token);
      expect(Buffer.from(inbound.data, "base64")).toEqual(Buffer.from([2]));
      await bridge.close(second.token);
    } finally {
      await dispose(bridge, sockets);
    }
  });

  it("rejects concurrent clients across handoff", async () => {
    const bridge = new SerialBridge();
    const sockets: net.Socket[] = [];
    try {
      const { token, port } = await bridge.create();
      const first = await connect(port);
      sockets.push(first);
      first.write(Buffer.from([1]));
      const synced = await bridge.poll(token);
      expect(synced.connected).toBe(true);
      const busy = await connect(port);
      sockets.push(busy);
      await new Promise<void>((resolve) => {
        if (busy.destroyed) resolve();
        else busy.once("close", () => resolve());
      });
      expect(busy.destroyed).toBe(true);
      const pending = bridge.poll(token);
      first.destroy();
      await expect(pending).resolves.toEqual({ data: "", connected: false, closed: false });
      const third = await connect(port);
      sockets.push(third);
      const fourth = await connect(port);
      sockets.push(fourth);
      await new Promise<void>((resolve) => {
        if (fourth.destroyed) resolve();
        else fourth.once("close", () => resolve());
      });
      expect(fourth.destroyed).toBe(true);
      expect(third.destroyed).toBe(false);
      third.write(Buffer.from([3]));
      const inbound = await bridge.poll(token);
      expect(inbound.connected).toBe(true);
      expect(Buffer.from(inbound.data, "base64")).toEqual(Buffer.from([3]));
      await bridge.close(token);
    } finally {
      await dispose(bridge, sockets);
    }
  });

  it("keeps the new owner healthy when the old socket tears down late", async () => {
    const bridge = new SerialBridge();
    const sockets: net.Socket[] = [];
    try {
      const { token, port } = await bridge.create();
      const first = await connect(port);
      sockets.push(first);
      first.write(Buffer.from([1]));
      const synced = await bridge.poll(token);
      expect(synced.connected).toBe(true);
      // Second handshake already in flight while the slot is still owned; the
      // release below frees the slot synchronously, so the late accept must
      // win and the old socket's teardown must not harm the new owner.
      const incoming = net.connect(port, "127.0.0.1");
      incoming.on("error", () => {});
      const firstClosed = new Promise<void>((resolve) => {
        first.once("close", () => resolve());
      });
      await bridge.release(token);
      await new Promise<void>((resolve, reject) => {
        incoming.once("connect", () => {
          incoming.off("error", reject);
          resolve();
        });
        incoming.once("error", reject);
      });
      sockets.push(incoming);
      await firstClosed;
      incoming.write(Buffer.from([7]));
      const inbound = await bridge.poll(token);
      expect(inbound.connected).toBe(true);
      expect(Buffer.from(inbound.data, "base64")).toEqual(Buffer.from([7]));
      const received = readBytes(incoming, 2);
      await bridge.write(token, Buffer.from([8, 8]).toString("base64"));
      expect(await received).toEqual(Buffer.from([8, 8]));
      await expect(bridge.create()).rejects.toThrow("already active");
      await bridge.close(token);
    } finally {
      await dispose(bridge, sockets);
    }
  });

  it("settles a genuinely pending device-to-host write on release without duplicating it", async () => {
    // Loopback sockets flush synchronously, so backpressure needs a corked
    // first socket: its writes buffer instead of flushing, which parks the
    // write in the drain wait deterministically. Later owners stay uncorked.
    let corked = false;
    const bridge = new SerialBridge({
      createServer: () => {
        const listener = net.createServer({ highWaterMark: 16 });
        listener.on("connection", (socket) => {
          if (!corked) {
            corked = true;
            socket.cork();
          }
        });
        return listener;
      },
    });
    const sockets: net.Socket[] = [];
    try {
      const { token, port } = await bridge.create();
      const first = await connect(port);
      sockets.push(first);
      first.write(Buffer.from([1]));
      const synced = await bridge.poll(token);
      expect(synced.connected).toBe(true);
      const pending = bridge.write(token, randomBytes(1024).toString("base64"));
      let settled = false;
      void pending.then(
        () => (settled = true),
        () => (settled = true),
      );
      // Microtasks only: drain and close need an I/O turn, so a settled flag
      // here would mean the write never parked. It must still be pending.
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false); // genuinely pending BEFORE release
      const closed = new Promise<void>((resolve) => {
        first.once("close", () => resolve());
      });
      await bridge.release(token);
      await closed;
      await expect(pending).resolves.toEqual({});
      // The next owner works and receives only new bytes, never a replay.
      const next = await connect(port);
      sockets.push(next);
      next.write(Buffer.from([2]));
      const inbound = await bridge.poll(token);
      expect(inbound.connected).toBe(true);
      expect(Buffer.from(inbound.data, "base64")).toEqual(Buffer.from([2]));
      const received = readBytes(next, 2);
      await bridge.write(token, Buffer.from([8, 8]).toString("base64"));
      expect(await received).toEqual(Buffer.from([8, 8]));
      await bridge.close(token);
    } finally {
      await dispose(bridge, sockets);
    }
  });

  it("expires the lease across handoffs without browser polls", async () => {
    const clock = new FakeClock();
    const bridge = new SerialBridge({ clock, leaseMs: 20_000, pollTimeoutMs: 60_000 });
    const sockets: net.Socket[] = [];
    try {
      const { token, port } = await bridge.create();
      const first = await connect(port);
      sockets.push(first);
      await bridge.release(token);
      const second = await connect(port);
      sockets.push(second);
      const closed = new Promise<void>((resolve) => {
        second.once("close", () => resolve());
      });
      clock.advance(20_000); // handoff renewed nothing: the create lease fires
      await closed;
      await expect(bridge.poll(token)).resolves.toEqual({
        data: "",
        connected: false,
        closed: true,
      });
      expect(clock.pendingTimers).toBe(0);
    } finally {
      await dispose(bridge, sockets);
    }
  });

  it("closes the bridge on new-owner overflow after handoff", async () => {
    const bridge = new SerialBridge({ maxBufferedBytes: 64 });
    const sockets: net.Socket[] = [];
    try {
      const { token, port } = await bridge.create();
      const first = await connect(port);
      sockets.push(first);
      await bridge.release(token);
      const second = await connect(port);
      sockets.push(second);
      const closed = new Promise<void>((resolve) => {
        second.once("close", () => resolve());
      });
      second.write(Buffer.alloc(65, 0x41));
      await closed;
      expect(second.destroyed).toBe(true);
      await expect(bridge.poll(token)).resolves.toEqual({
        data: "",
        connected: false,
        closed: true,
      });
      const fresh = await bridge.create();
      await bridge.close(fresh.token);
    } finally {
      await dispose(bridge, sockets);
    }
  });

  it("makes close idempotent but never lets a stale token touch a new bridge", async () => {
    const bridge = new SerialBridge();
    const sockets: net.Socket[] = [];
    try {
      const { token } = await bridge.create();
      await bridge.close(token);
      await bridge.close(token);
      const second = await bridge.create();
      expect(second.token).not.toBe(token);
      // Stale token observes closed/idempotent results but touches nothing.
      expect(await bridge.poll(token)).toMatchObject({ closed: true });
      await expect(bridge.renew(token)).rejects.toThrow("Unknown bridge token");
      await expect(bridge.write(token, "")).rejects.toThrow("Unknown bridge token");
      await bridge.close(token);
      const socket = await connect(second.port);
      sockets.push(socket);
      const pending = bridge.poll(second.token);
      socket.write(Buffer.from([5]));
      expect(Buffer.from((await pending).data, "base64")).toEqual(Buffer.from([5]));
      await bridge.close(second.token);
    } finally {
      await dispose(bridge, sockets);
    }
  });

  it("dispose clears sockets, timers, and pending polls", async () => {
    const clock = new FakeClock();
    const bridge = new SerialBridge({ clock });
    const sockets: net.Socket[] = [];
    try {
      const { port, token } = await bridge.create();
      const socket = await connect(port);
      sockets.push(socket);
      const pending = bridge.poll(token);
      bridge.dispose();
      expect(await pending).toMatchObject({ closed: true });
      expect(clock.pendingTimers).toBe(0);
      bridge.dispose();
      await expect(bridge.create()).rejects.toThrow("disposed");
    } finally {
      await dispose(bridge, sockets);
    }
  });
});
