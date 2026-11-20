import { describe, expect, it, vi } from "vitest";
import {
  openClientSecureChannel,
  openDaemonSecureChannel,
  SecureChannelRejectedError,
  type SecureChannel,
} from "./secure-channel.js";
import {
  createClientChannel,
  createDaemonChannel,
  type Transport,
  type TransportMessage,
} from "./encrypted-channel.js";
import { exportPublicKey, generateKeyPair } from "./crypto.js";
import { MAX_CHUNK_DATA_BYTES } from "./protected-records.js";

interface Frame {
  data: string | ArrayBuffer;
  isBinary: boolean;
}
type Interceptor = (frame: Frame) => Frame | null;

/**
 * Two transports wired back to back through an optional interceptor per
 * direction, standing in for a relay that may record, drop, reorder, or
 * rewrite frames.
 */
/** Delivers a frame to a transport a few milliseconds later, like a relay retry. */
function deliverLater(transport: Transport, frame: TransportMessage, ms = 5): void {
  setTimeout(() => transport.onmessage?.(frame), ms);
}

function createLink() {
  const toDaemon: Frame[] = [];
  const toClient: Frame[] = [];
  let interceptToDaemon: Interceptor = (frame) => frame;
  let interceptToClient: Interceptor = (frame) => frame;

  const daemon: Transport = {
    send: vi.fn((data: string | ArrayBuffer) => {
      const recorded = toFrame(data);
      toClient.push(recorded);
      const frame = interceptToClient(recorded);
      if (frame) setTimeout(() => client.onmessage?.(frame), 0);
    }),
    close: vi.fn(),
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  const client: Transport = {
    send: vi.fn((data: string | ArrayBuffer) => {
      const recorded = toFrame(data);
      toDaemon.push(recorded);
      const frame = interceptToDaemon(recorded);
      if (frame) setTimeout(() => daemon.onmessage?.(frame), 0);
    }),
    // The client may run in a browser: WebSocket.close throws on any code other
    // than 1000 or 3000-4999 and leaves the socket open, so mirror that here.
    close: vi.fn((code?: number, reason?: string) => {
      if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
        throw new DOMException(
          `The code must be either 1000, or between 3000 and 4999. ${code} is neither.`,
          "InvalidAccessError",
        );
      }
      setTimeout(() => client.onclose?.(code ?? 1005, reason ?? ""), 0);
    }),
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  return {
    daemon,
    client,
    recordedToDaemon: toDaemon,
    recordedToClient: toClient,
    setToDaemon(fn: Interceptor) {
      interceptToDaemon = fn;
    },
    setToClient(fn: Interceptor) {
      interceptToClient = fn;
    },
  };
}

function toFrame(data: string | ArrayBuffer): Frame {
  return { data, isBinary: data instanceof ArrayBuffer };
}

async function settle(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface Pair {
  link: ReturnType<typeof createLink>;
  daemonKeyPair: ReturnType<typeof generateKeyPair>;
  client: SecureChannel;
  daemon: SecureChannel;
  daemonReceived: Array<string | ArrayBuffer>;
  clientReceived: Array<string | ArrayBuffer>;
}

async function openProtectedPair(
  options: {
    link?: ReturnType<typeof createLink>;
    daemonKeyPair?: ReturnType<typeof generateKeyPair>;
    clientMinimum?: "legacy" | "protected";
    daemonMinimum?: "legacy" | "protected";
  } = {},
): Promise<Pair> {
  const link = options.link ?? createLink();
  const daemonKeyPair = options.daemonKeyPair ?? generateKeyPair();
  const daemonReceived: Array<string | ArrayBuffer> = [];
  const clientReceived: Array<string | ArrayBuffer> = [];
  const opened = deferred();
  const daemonPromise = openDaemonSecureChannel(link.daemon, {
    daemonKeyPair,
    minimumMode: options.daemonMinimum,
    events: { onmessage: (data) => daemonReceived.push(data) },
  });
  const client = await openClientSecureChannel(link.client, {
    daemonPublicKeyB64: exportPublicKey(daemonKeyPair.publicKey),
    minimumMode: options.clientMinimum,
    events: { onopen: () => opened.resolve(), onmessage: (data) => clientReceived.push(data) },
  });
  const daemon = await daemonPromise;
  await opened.promise;
  return { link, daemonKeyPair, client, daemon, daemonReceived, clientReceived };
}

function bytes(length: number): ArrayBuffer {
  return new Uint8Array(length).map((_, i) => (i * 13 + 1) & 0xff).buffer;
}

describe("secure channel: protected mode", () => {
  it("negotiates protected mode between two updated peers and carries both frame kinds", async () => {
    const pair = await openProtectedPair();
    expect(pair.client.securityMode()).toBe("protected");
    expect(pair.daemon.securityMode()).toBe("protected");

    await pair.client.send("hello daemon");
    await pair.client.send(bytes(5));
    await pair.daemon.send("hello client");
    await pair.daemon.send(bytes(7));
    await settle();

    expect(pair.daemonReceived[0]).toBe("hello daemon");
    expect(new Uint8Array(pair.daemonReceived[1] as ArrayBuffer)).toEqual(new Uint8Array(bytes(5)));
    expect(pair.clientReceived[0]).toBe("hello client");
    expect(new Uint8Array(pair.clientReceived[1] as ArrayBuffer)).toEqual(new Uint8Array(bytes(7)));
  });

  it("keeps text as base64 text frames and binary as binary frames when negotiated", async () => {
    const pair = await openProtectedPair();
    pair.link.recordedToDaemon.length = 0;
    await pair.client.send("text");
    await pair.client.send(bytes(3));
    await settle();
    expect(pair.link.recordedToDaemon.map((frame) => frame.isBinary)).toEqual([false, true]);
    expect(pair.link.recordedToDaemon[0].data).not.toContain("text");
    expect(pair.client.outboundWireByteLength(bytes(3))).toBe(3 + 2 + 6 + 16);
    expect(pair.client.outboundWireByteLength("text")).toBe(4 * Math.ceil((4 + 24) / 3));
  });

  it("carries frames larger than one Noise message", async () => {
    const pair = await openProtectedPair();
    const big = bytes(MAX_CHUNK_DATA_BYTES * 2 + 100);
    await pair.client.send(big);
    await settle(100);
    expect(new Uint8Array(pair.daemonReceived[0] as ArrayBuffer)).toEqual(new Uint8Array(big));
  });

  it("flushes sends queued before the handshake completes, in order", async () => {
    const link = createLink();
    const daemonKeyPair = generateKeyPair();
    const daemonReceived: Array<string | ArrayBuffer> = [];
    const daemonPromise = openDaemonSecureChannel(link.daemon, {
      daemonKeyPair,
      events: { onmessage: (data) => daemonReceived.push(data) },
    });
    const client = await openClientSecureChannel(link.client, {
      daemonPublicKeyB64: exportPublicKey(daemonKeyPair.publicKey),
    });
    await client.send("one");
    await client.send("two");
    expect(client.isOpen()).toBe(false);
    await daemonPromise;
    await settle();
    expect(daemonReceived).toEqual(["one", "two"]);
  });

  it("rejects an exact duplicate record and delivers nothing twice", async () => {
    const pair = await openProtectedPair();
    let captured: Frame | null = null;
    pair.link.setToDaemon((frame) => {
      captured ??= frame;
      return frame;
    });
    await pair.client.send("once");
    await settle();
    expect(pair.daemonReceived).toEqual(["once"]);

    pair.link.daemon.onmessage?.(captured!);
    await settle();
    expect(pair.daemonReceived).toEqual(["once"]);
    expect(pair.link.daemon.close).toHaveBeenCalledWith(1011, expect.any(String));
  });

  it("rejects a reflected record", async () => {
    const pair = await openProtectedPair();
    let captured: Frame | null = null;
    pair.link.setToDaemon((frame) => {
      captured ??= frame;
      return frame;
    });
    await pair.client.send("mine");
    await settle();
    pair.link.client.onmessage?.(captured!);
    await settle();
    expect(pair.clientReceived).toEqual([]);
    expect(pair.link.client.close).toHaveBeenCalledWith(4003, expect.any(String));
  });

  it("closes the browser socket and reports the close when a record fails at the client", async () => {
    const closes: Array<[number, string]> = [];
    const link = createLink();
    const daemonKeyPair = generateKeyPair();
    const daemonPromise = openDaemonSecureChannel(link.daemon, { daemonKeyPair });
    const client = await openClientSecureChannel(link.client, {
      daemonPublicKeyB64: exportPublicKey(daemonKeyPair.publicKey),
      events: { onclose: (code, reason) => closes.push([code, reason]) },
    });
    await daemonPromise;
    await settle();
    link.client.onmessage?.({
      data: Buffer.from("not a record").toString("base64"),
      isBinary: false,
    });
    await settle();
    expect(client.isOpen()).toBe(false);
    expect(closes).toEqual([[4003, expect.any(String)]]);
  });

  it("rejects out-of-order records and delivers nothing from them", async () => {
    const pair = await openProtectedPair();
    const held: Frame[] = [];
    pair.link.setToDaemon((frame) => {
      held.push(frame);
      return null;
    });
    await pair.client.send("first");
    await pair.client.send("second");
    await settle();
    expect(held).toHaveLength(2);
    pair.link.daemon.onmessage?.(held[1]);
    await settle();
    expect(pair.daemonReceived).toEqual([]);
    expect(pair.link.daemon.close).toHaveBeenCalledWith(1011, expect.any(String));
    pair.link.daemon.onmessage?.(held[0]);
    await settle();
    expect(pair.daemonReceived).toEqual([]);
  });

  it("rejects a tampered record without delivering it", async () => {
    const pair = await openProtectedPair();
    pair.link.setToDaemon((frame) => {
      const tampered = new Uint8Array((frame.data as ArrayBuffer).slice(0));
      tampered[tampered.byteLength - 1] ^= 0x01;
      return { data: tampered.buffer, isBinary: true };
    });
    await pair.client.send(bytes(10));
    await settle();
    expect(pair.daemonReceived).toEqual([]);
    expect(pair.link.daemon.close).toHaveBeenCalledWith(1011, expect.any(String));
  });

  it("closes on plaintext application traffic", async () => {
    const pair = await openProtectedPair();
    pair.link.daemon.onmessage?.({ data: JSON.stringify({ type: "hello" }), isBinary: false });
    await settle();
    expect(pair.link.daemon.close).toHaveBeenCalledWith(1011, expect.any(String));
    expect(pair.daemonReceived).toEqual([]);
  });

  it("answers an identical hello retry with the identical ready and keeps counters", async () => {
    const pair = await openProtectedPair();
    const hello = pair.link.recordedToDaemon.find(
      (frame) => typeof frame.data === "string" && frame.data.includes('"e2ee_hello"'),
    );
    const readyFrames = () =>
      (pair.link.daemon.send as ReturnType<typeof vi.fn>).mock.calls
        .map(([data]) => data)
        .filter((data) => typeof data === "string" && data.includes('"e2ee_ready"'));
    expect(hello).toBeDefined();
    expect(readyFrames()).toHaveLength(1);

    pair.link.daemon.onmessage?.(hello!);
    await settle();
    expect(readyFrames()).toHaveLength(2);
    expect(readyFrames()[0]).toBe(readyFrames()[1]);
    expect(pair.link.daemon.close).not.toHaveBeenCalled();

    await pair.client.send("still protected");
    await pair.daemon.send("both ways");
    await settle();
    expect(pair.daemonReceived).toEqual(["still protected"]);
    expect(pair.clientReceived).toEqual(["both ways"]);
  });

  it("closes when a different hello arrives on an open channel", async () => {
    const pair = await openProtectedPair();
    const hello = pair.link.recordedToDaemon.find(
      (frame) => typeof frame.data === "string" && frame.data.includes('"e2ee_hello"'),
    )!;
    const changed = (hello.data as string).replace('"v":1', '"v":1 ');
    expect(changed).not.toBe(hello.data);
    pair.link.daemon.onmessage?.({ data: changed, isBinary: false });
    await settle();
    expect(pair.link.daemon.close).toHaveBeenCalledWith(1008, expect.stringContaining("mismatch"));
  });

  it("answers an identical hello that arrives while the ready send is in flight", async () => {
    const link = createLink();
    const daemonKeyPair = generateKeyPair();
    const sendFromDaemon = link.daemon.send;
    link.daemon.send = vi.fn(async (data: string | ArrayBuffer) => {
      await settle(20);
      sendFromDaemon(data);
    });
    link.setToDaemon((frame) => {
      // The relay delivers the client's 1s retry while the daemon is still sending ready.
      if (typeof frame.data === "string" && frame.data.includes('"e2ee_hello"')) {
        deliverLater(link.daemon, frame);
      }
      return frame;
    });
    const daemonPromise = openDaemonSecureChannel(link.daemon, { daemonKeyPair });
    const client = await openClientSecureChannel(link.client, {
      daemonPublicKeyB64: exportPublicKey(daemonKeyPair.publicKey),
    });
    const daemon = await daemonPromise;
    await settle(80);
    const readyFrames = link.recordedToClient.filter(
      (frame) => typeof frame.data === "string" && frame.data.includes('"e2ee_ready"'),
    );
    expect(readyFrames).toHaveLength(2);
    expect(readyFrames[0].data).toBe(readyFrames[1].data);
    expect(link.daemon.close).not.toHaveBeenCalled();
    expect(client.isOpen()).toBe(true);
    expect(daemon.isOpen()).toBe(true);
  });

  it("closes when a different hello arrives while the ready send is in flight", async () => {
    const link = createLink();
    const daemonKeyPair = generateKeyPair();
    const sendFromDaemon = link.daemon.send;
    link.daemon.send = vi.fn(async (data: string | ArrayBuffer) => {
      await settle(20);
      sendFromDaemon(data);
    });
    link.setToDaemon((frame) => {
      if (typeof frame.data === "string" && frame.data.includes('"e2ee_hello"')) {
        const changed = frame.data.replace('"v":1', '"v":1 ');
        deliverLater(link.daemon, { data: changed, isBinary: false });
      }
      return frame;
    });
    const daemonPromise = openDaemonSecureChannel(link.daemon, { daemonKeyPair });
    await openClientSecureChannel(link.client, {
      daemonPublicKeyB64: exportPublicKey(daemonKeyPair.publicKey),
    });
    const daemon = await daemonPromise;
    await settle(80);
    expect(link.daemon.close).toHaveBeenCalledWith(1008, expect.stringContaining("mismatch"));
    expect(daemon.isOpen()).toBe(false);
  });

  it("does not let a recorded hello and records replay into a fresh daemon channel", async () => {
    // Session 1: a legitimate client talks to the daemon; the relay records everything.
    const first = await openProtectedPair();
    await first.client.send("secret command");
    await first.client.send(bytes(4));
    await settle();
    expect(first.daemonReceived).toHaveLength(2);
    const transcript = first.link.recordedToDaemon.slice();
    expect(transcript.length).toBeGreaterThanOrEqual(3);

    // Session 2: the same daemon key pair (restart or reconnect), attacker replays the transcript.
    const link = createLink();
    const replayed: Array<string | ArrayBuffer> = [];
    const daemonPromise = openDaemonSecureChannel(link.daemon, {
      daemonKeyPair: first.daemonKeyPair,
      events: { onmessage: (data) => replayed.push(data) },
    });
    for (const frame of transcript) link.daemon.onmessage?.(frame);
    const daemon = await daemonPromise;
    await settle();
    expect(daemon.securityMode()).toBe("protected");
    expect(replayed).toEqual([]);
    expect(link.daemon.close).toHaveBeenCalledWith(1011, expect.any(String));
  });
});

describe("secure channel: negotiation and policy", () => {
  it("rejects a present but invalid protected hello instead of falling back", async () => {
    for (const mutate of [
      (hello: Record<string, unknown>) => ({ ...hello, protected: { v: 2, message: "AAAA" } }),
      (hello: Record<string, unknown>) => ({ ...hello, protected: { v: 1, message: "AAAA" } }),
      (hello: Record<string, unknown>) => ({ ...hello, protected: "nope" }),
    ]) {
      const link = createLink();
      const daemonKeyPair = generateKeyPair();
      link.setToDaemon((frame) => {
        if (typeof frame.data !== "string") return frame;
        return { data: JSON.stringify(mutate(JSON.parse(frame.data))), isBinary: false };
      });
      const daemonPromise = openDaemonSecureChannel(link.daemon, { daemonKeyPair });
      await openClientSecureChannel(link.client, {
        daemonPublicKeyB64: exportPublicKey(daemonKeyPair.publicKey),
      });
      await expect(daemonPromise).rejects.toThrow();
      expect((link.daemon.send as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    }
  });

  it("rejects a malformed protected ready instead of waiting for a legacy one", async () => {
    for (const protectedValue of [
      null,
      {},
      { v: 1, message: "" },
      { v: "1", message: "AAAA" },
      { v: 1, message: 7 },
      [],
    ]) {
      const link = createLink();
      const daemonKeyPair = generateKeyPair();
      link.setToClient((frame) => {
        if (typeof frame.data !== "string") return frame;
        const ready = JSON.parse(frame.data);
        // A tampered ready first, then the daemon's genuine legacy-shaped ready.
        deliverLater(link.client, {
          data: JSON.stringify({ type: "e2ee_ready" }),
          isBinary: false,
        });
        return { data: JSON.stringify({ ...ready, protected: protectedValue }), isBinary: false };
      });
      const daemonPromise = openDaemonSecureChannel(link.daemon, { daemonKeyPair });
      const client = await openClientSecureChannel(link.client, {
        daemonPublicKeyB64: exportPublicKey(daemonKeyPair.publicKey),
      });
      await daemonPromise;
      await settle(40);
      expect(link.client.close).toHaveBeenCalledWith(4002, expect.stringContaining("malformed"));
      expect(client.isOpen()).toBe(false);
      await expect(client.send("never")).rejects.toThrow("Channel not open");
    }
  });

  it("rejects a tampered protected ready and never retries legacy", async () => {
    const link = createLink();
    const daemonKeyPair = generateKeyPair();
    link.setToClient((frame) => {
      if (typeof frame.data !== "string") return frame;
      const ready = JSON.parse(frame.data);
      const message = Buffer.from(ready.protected.message, "base64");
      message[message.byteLength - 1] ^= 0x01;
      ready.protected.message = message.toString("base64");
      return { data: JSON.stringify(ready), isBinary: false };
    });
    const errors: Error[] = [];
    const daemonPromise = openDaemonSecureChannel(link.daemon, { daemonKeyPair });
    const client = await openClientSecureChannel(link.client, {
      daemonPublicKeyB64: exportPublicKey(daemonKeyPair.publicKey),
      events: { onerror: (error) => errors.push(error) },
    });
    await daemonPromise;
    await settle();
    expect(client.isOpen()).toBe(false);
    expect(link.client.close).toHaveBeenCalledWith(4002, expect.any(String));
    expect(errors).toHaveLength(1);
    await expect(client.send("x")).rejects.toThrow("Channel not open");
  });

  it("rejects a ready that selects an unoffered parameter", async () => {
    // The daemon cannot do this by itself; a forged msg2 would need the keys, so the
    // check is exercised by driving the decoder with a crafted selection.
    const link = createLink();
    const daemonKeyPair = generateKeyPair();
    link.setToClient((frame) => {
      if (typeof frame.data !== "string") return frame;
      const ready = JSON.parse(frame.data);
      ready.capabilities = { binaryCiphertext: true };
      return { data: JSON.stringify(ready), isBinary: false };
    });
    const daemonPromise = openDaemonSecureChannel(link.daemon, { daemonKeyPair });
    const client = await openClientSecureChannel(link.client, {
      daemonPublicKeyB64: exportPublicKey(daemonKeyPair.publicKey),
    });
    await daemonPromise;
    await settle();
    // Unauthenticated outer capabilities are ignored in protected mode.
    expect(client.isOpen()).toBe(true);
    expect(client.securityMode()).toBe("protected");
  });

  it("stripping protected from the ready does not downgrade a protected daemon", async () => {
    const link = createLink();
    const daemonKeyPair = generateKeyPair();
    link.setToClient((frame) => {
      if (typeof frame.data !== "string") return frame;
      const ready = JSON.parse(frame.data);
      delete ready.protected;
      return { data: JSON.stringify(ready), isBinary: false };
    });
    const daemonReceived: unknown[] = [];
    const daemonPromise = openDaemonSecureChannel(link.daemon, {
      daemonKeyPair,
      events: { onmessage: (data) => daemonReceived.push(data) },
    });
    const client = await openClientSecureChannel(link.client, {
      daemonPublicKeyB64: exportPublicKey(daemonKeyPair.publicKey),
    });
    await daemonPromise;
    await settle();
    expect(client.securityMode()).toBe("legacy");
    await client.send("legacy record");
    await settle();
    expect(daemonReceived).toEqual([]);
    expect(link.daemon.close).toHaveBeenCalledWith(1011, expect.any(String));
  });

  it("client with a protected minimum refuses a legacy-only daemon", async () => {
    const link = createLink();
    const daemonKeyPair = generateKeyPair();
    const errors: Error[] = [];
    const daemonPromise = createDaemonChannel(link.daemon, daemonKeyPair);
    const client = await openClientSecureChannel(link.client, {
      daemonPublicKeyB64: exportPublicKey(daemonKeyPair.publicKey),
      minimumMode: "protected",
      events: { onerror: (error) => errors.push(error) },
    });
    await daemonPromise;
    await settle();
    expect(client.isOpen()).toBe(false);
    expect(link.client.close).toHaveBeenCalledWith(4002, expect.stringContaining("legacy"));
  });

  it("daemon with a protected minimum refuses a legacy-only client", async () => {
    const link = createLink();
    const daemonKeyPair = generateKeyPair();
    const daemonPromise = openDaemonSecureChannel(link.daemon, {
      daemonKeyPair,
      minimumMode: () => "protected",
    });
    await createClientChannel(link.client, exportPublicKey(daemonKeyPair.publicKey));
    await expect(daemonPromise).rejects.toBeInstanceOf(SecureChannelRejectedError);
    await expect(daemonPromise).rejects.toMatchObject({
      closeCode: 1008,
      closeReason: "protected endpoint security required",
    });
    expect((link.daemon.send as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});

describe("secure channel: legacy compatibility", () => {
  it("new client against an old daemon negotiates legacy and exchanges records", async () => {
    const link = createLink();
    const daemonKeyPair = generateKeyPair();
    const daemonReceived: unknown[] = [];
    const clientReceived: unknown[] = [];
    const opened = deferred();
    const daemonPromise = createDaemonChannel(link.daemon, daemonKeyPair, {
      onmessage: (data) => daemonReceived.push(data),
    });
    const client = await openClientSecureChannel(link.client, {
      daemonPublicKeyB64: exportPublicKey(daemonKeyPair.publicKey),
      events: { onopen: () => opened.resolve(), onmessage: (data) => clientReceived.push(data) },
    });
    const daemon = await daemonPromise;
    await opened.promise;
    expect(client.securityMode()).toBe("legacy");
    await client.send("from new client");
    await daemon.send("from old daemon");
    await settle();
    expect(daemonReceived).toEqual(["from new client"]);
    expect(clientReceived).toEqual(["from old daemon"]);
  });

  it("old client against a new daemon negotiates legacy and keeps legacy retry semantics", async () => {
    const link = createLink();
    const daemonKeyPair = generateKeyPair();
    const daemonReceived: unknown[] = [];
    const opened = deferred();
    const daemonPromise = openDaemonSecureChannel(link.daemon, {
      daemonKeyPair,
      events: { onmessage: (data) => daemonReceived.push(data) },
    });
    const client = await createClientChannel(
      link.client,
      exportPublicKey(daemonKeyPair.publicKey),
      {
        onopen: () => opened.resolve(),
      },
    );
    const daemon = await daemonPromise;
    await opened.promise;
    expect(daemon.securityMode()).toBe("legacy");
    const hello = (link.client.send as ReturnType<typeof vi.fn>).mock.calls.find(
      ([data]) => typeof data === "string" && data.includes('"e2ee_hello"'),
    )?.[0] as string;
    link.daemon.onmessage?.({ data: hello, isBinary: false });
    await settle();
    expect(link.daemon.close).not.toHaveBeenCalled();
    await client.send("legacy still works");
    await settle();
    expect(daemonReceived).toEqual(["legacy still works"]);
  });
});
