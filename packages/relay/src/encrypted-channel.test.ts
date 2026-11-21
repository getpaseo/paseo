import { describe, it, expect, vi } from "vitest";
import {
  createClientChannel,
  createDaemonChannel,
  EncryptedChannel,
  Transport,
} from "./encrypted-channel.js";
import { deflateSync } from "fflate";
import {
  decrypt,
  deriveSharedKey,
  encrypt,
  exportPublicKey,
  generateKeyPair,
  importPublicKey,
} from "./crypto.js";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./base64.js";
import {
  COMPRESSIBILITY_PROBE_MIN_BYTES,
  DEFLATE_TEXT_MIN_BYTES,
  MAX_INFLATED_TEXT_BYTES,
} from "./plaintext-frame.js";

/**
 * Creates a pair of connected mock transports.
 * Messages sent on one are received on the other.
 */
function createMockTransportPair(): [Transport, Transport] {
  const transportA: Transport = {
    send: vi.fn(),
    close: vi.fn(),
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  const transportB: Transport = {
    send: vi.fn(),
    close: vi.fn(),
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  // Wire them together
  (transportA.send as ReturnType<typeof vi.fn>).mockImplementation((data: string | ArrayBuffer) => {
    setTimeout(() => transportB.onmessage?.({ data, isBinary: data instanceof ArrayBuffer }), 0);
  });

  (transportB.send as ReturnType<typeof vi.fn>).mockImplementation((data: string | ArrayBuffer) => {
    setTimeout(() => transportA.onmessage?.({ data, isBinary: data instanceof ArrayBuffer }), 0);
  });

  return [transportA, transportB];
}

async function waitForAsyncDelivery(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function sentFrames(transport: Transport): Array<string | ArrayBuffer> {
  return (transport.send as ReturnType<typeof vi.fn>).mock.calls.map(
    ([data]) => data as string | ArrayBuffer,
  );
}

function decodeUtf8(data: ArrayBuffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(data);
}

/** ASCII JSON-shaped text with repeated keys, like a timeline page, of exactly `byteLength` bytes. */
function compressibleText(byteLength: number): string {
  const rows: string[] = [];
  let length = 2;
  for (let index = 0; length < byteLength; index += 1) {
    const row = JSON.stringify({ type: "assistant_message", seq: index, text: "hello world" });
    rows.push(row);
    length += row.length + 1;
  }
  return `[${rows.join(",")}]`.slice(0, byteLength);
}

async function openClientWithReady(
  transport: Transport,
  opened: Promise<void>,
  capabilities?: Record<string, boolean>,
): Promise<void> {
  transport.onmessage?.({
    data: JSON.stringify({ type: "e2ee_ready", ...(capabilities ? { capabilities } : {}) }),
    isBinary: false,
  });
  await opened;
}

interface FramedPair {
  sharedKey: Uint8Array;
  sender: EncryptedChannel;
  senderTransport: Transport;
  receiverTransport: Transport;
  received: (string | ArrayBuffer)[];
}

/** Two open channels that already negotiated `deflatePayloads`, sharing a known key. */
function createFramedPair(): FramedPair {
  const [senderTransport, receiverTransport] = createMockTransportPair();
  const first = generateKeyPair();
  const second = generateKeyPair();
  const sharedKey = deriveSharedKey(first.secretKey, second.publicKey);
  const options = { binaryCiphertext: true, deflatePayloads: true };
  const received: (string | ArrayBuffer)[] = [];
  const sender = new EncryptedChannel(senderTransport, sharedKey, {}, options);
  const receiver = new EncryptedChannel(
    receiverTransport,
    sharedKey,
    { onmessage: (data) => received.push(data) },
    options,
  );
  sender.setState("open");
  receiver.setState("open");
  return { sharedKey, sender, senderTransport, receiverTransport, received };
}

function lastFramedPlaintext(pair: FramedPair): Uint8Array {
  const frames = sentFrames(pair.senderTransport);
  const frame = frames[frames.length - 1];
  expect(frame).toBeInstanceOf(ArrayBuffer);
  return new Uint8Array(decrypt(pair.sharedKey, frame as ArrayBuffer));
}

function deflateFrame(declaredLength: number, text: string): ArrayBuffer {
  const compressed = deflateSync(new TextEncoder().encode(text));
  const frame = new Uint8Array(5 + compressed.byteLength);
  frame[0] = 0x02;
  new DataView(frame.buffer).setUint32(1, declaredLength, true);
  frame.set(compressed, 5);
  return frame.buffer;
}

describe("EncryptedChannel", () => {
  it("rejects the daemon handshake when the ready frame fails to send", async () => {
    const daemonKeyPair = generateKeyPair();
    const clientKeyPair = generateKeyPair();
    const transport: Transport = {
      send: () => Promise.reject(new Error("ready send failed")),
      close: () => undefined,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    const channel = createDaemonChannel(transport, daemonKeyPair);

    transport.onmessage?.({
      data: JSON.stringify({
        type: "e2ee_hello",
        key: exportPublicKey(clientKeyPair.publicKey),
      }),
      isBinary: false,
    });

    await expect(channel).rejects.toThrow("ready send failed");
  });

  it("waits for transport send completion", async () => {
    let completeSend: (() => void) | undefined;
    const transport: Transport = {
      send: () =>
        new Promise<void>((resolve) => {
          completeSend = resolve;
        }),
      close: () => undefined,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    const first = generateKeyPair();
    const second = generateKeyPair();
    const channel = new EncryptedChannel(
      transport,
      deriveSharedKey(first.secretKey, second.publicKey),
      {},
      { binaryCiphertext: true },
    );
    channel.setState("open");
    let completed = false;

    const sending = channel.send(new Uint8Array([1, 2, 3]).buffer).then(() => {
      completed = true;
      return undefined;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    completeSend?.();
    await sending;
    expect(completed).toBe(true);
  });

  it("establishes encrypted channel between daemon and client", async () => {
    const [daemonTransport, clientTransport] = createMockTransportPair();

    // Daemon generates keypair (public key goes in QR)
    const daemonKeyPair = generateKeyPair();
    const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);

    let clientOpenedResolve: (() => void) | null = null;
    const clientOpened = new Promise<void>((resolve) => {
      clientOpenedResolve = resolve;
    });

    // Start daemon waiting for client
    const daemonChannelPromise = createDaemonChannel(daemonTransport, daemonKeyPair);

    // Client connects (scanned QR, got daemon's public key)
    const clientChannel = await createClientChannel(clientTransport, daemonPubKeyB64, {
      onopen: () => clientOpenedResolve?.(),
    });

    // Daemon receives hello and completes handshake
    const daemonChannel = await daemonChannelPromise;
    await clientOpened;

    expect(clientChannel.isOpen()).toBe(true);
    expect(daemonChannel.isOpen()).toBe(true);
  });

  it("exchanges encrypted messages bidirectionally", async () => {
    const [daemonTransport, clientTransport] = createMockTransportPair();

    const daemonKeyPair = generateKeyPair();
    const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);

    const daemonMessages: (string | ArrayBuffer)[] = [];
    const clientMessages: (string | ArrayBuffer)[] = [];

    let clientOpenedResolve: (() => void) | null = null;
    const clientOpened = new Promise<void>((resolve) => {
      clientOpenedResolve = resolve;
    });

    const daemonChannelPromise = createDaemonChannel(daemonTransport, daemonKeyPair, {
      onmessage: (data) => daemonMessages.push(data),
    });

    const clientChannel = await createClientChannel(clientTransport, daemonPubKeyB64, {
      onmessage: (data) => clientMessages.push(data),
      onopen: () => clientOpenedResolve?.(),
    });

    const daemonChannel = await daemonChannelPromise;
    await clientOpened;

    // Send messages both directions
    await clientChannel.send("Hello from client");
    await daemonChannel.send("Hello from daemon");
    await clientChannel.send("Second message from client");

    // Wait for async delivery
    await waitForAsyncDelivery();

    expect(daemonMessages).toEqual(["Hello from client", "Second message from client"]);
    expect(clientMessages).toEqual(["Hello from daemon"]);
  });

  it("encrypted messages are opaque to transport", async () => {
    const [daemonTransport, clientTransport] = createMockTransportPair();

    const daemonKeyPair = generateKeyPair();
    const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);

    let clientOpenedResolve: (() => void) | null = null;
    const clientOpened = new Promise<void>((resolve) => {
      clientOpenedResolve = resolve;
    });

    const daemonChannelPromise = createDaemonChannel(daemonTransport, daemonKeyPair);
    const clientChannel = await createClientChannel(clientTransport, daemonPubKeyB64, {
      onopen: () => clientOpenedResolve?.(),
    });
    await daemonChannelPromise;
    await clientOpened;

    // Clear mock call history
    (clientTransport.send as ReturnType<typeof vi.fn>).mockClear();

    // Send a plaintext message
    const plaintext = "Secret message";
    await clientChannel.send(plaintext);

    // Check what was actually sent over the transport
    expect(clientTransport.send).toHaveBeenCalledTimes(1);
    const sentData = (clientTransport.send as ReturnType<typeof vi.fn>).mock.calls[0][0];

    // Negotiated peers send every ciphertext as a binary frame
    expect(sentData).toBeInstanceOf(ArrayBuffer);
    // Should NOT contain the plaintext
    expect(Buffer.from(sentData as ArrayBuffer).includes(Buffer.from(plaintext))).toBe(false);
    // Nonce + auth tag + framing header
    expect((sentData as ArrayBuffer).byteLength).toBe(plaintext.length + 41);
  });

  it("does not throw uncaught when handshake hello retry send fails", async () => {
    vi.useFakeTimers();
    try {
      const daemonKeyPair = generateKeyPair();
      const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);

      const transport: Transport = {
        send: vi.fn(),
        close: vi.fn(),
        onmessage: null,
        onclose: null,
        onerror: null,
      };

      let sendAttempts = 0;
      (transport.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
        sendAttempts += 1;
        if (sendAttempts >= 2) {
          throw new Error("WebSocket not open (readyState=2)");
        }
      });

      const onerror = vi.fn();
      await createClientChannel(transport, daemonPubKeyB64, { onerror });

      expect(() => {
        vi.advanceTimersByTime(1000);
      }).not.toThrow();

      expect(onerror).toHaveBeenCalledTimes(1);
      expect(onerror.mock.calls[0][0]).toBeInstanceOf(Error);
      expect((onerror.mock.calls[0][0] as Error).message).toContain("WebSocket not open");

      // Close the transport to stop retry timer.
      transport.onclose?.(1000, "closed");
      vi.runOnlyPendingTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports rejected handshake hello sends", async () => {
    const daemonKeyPair = generateKeyPair();
    const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);
    const transport: Transport = {
      send: () => Promise.reject(new Error("hello send failed")),
      close: vi.fn(),
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    const onerror = vi.fn();

    await createClientChannel(transport, daemonPubKeyB64, { onerror });
    await Promise.resolve();

    expect(onerror).toHaveBeenCalledTimes(1);
    expect((onerror.mock.calls[0][0] as Error).message).toBe("hello send failed");
    transport.onclose?.(1000, "closed");
  });

  it("reports rejected sends while flushing the handshake backlog", async () => {
    const daemonKeyPair = generateKeyPair();
    const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);
    let sendAttempts = 0;
    const transport: Transport = {
      send: () => {
        sendAttempts += 1;
        return sendAttempts === 1 ? undefined : Promise.reject(new Error("backlog send failed"));
      },
      close: vi.fn(),
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    const onerror = vi.fn();
    const channel = await createClientChannel(transport, daemonPubKeyB64, { onerror });
    await channel.send(new ArrayBuffer(8));

    transport.onmessage?.({
      data: JSON.stringify({
        type: "e2ee_ready",
        capabilities: { binaryCiphertext: true },
      }),
      isBinary: false,
    });
    await waitForAsyncDelivery();

    expect(onerror).toHaveBeenCalledTimes(1);
    expect((onerror.mock.calls[0][0] as Error).message).toBe("backlog send failed");
    expect(transport.close).toHaveBeenCalledWith(1011, "backlog send failed");
  });

  it("fails handshake on invalid hello", async () => {
    const [daemonTransport] = createMockTransportPair();

    const daemonKeyPair = generateKeyPair();

    const daemonChannelPromise = createDaemonChannel(daemonTransport, daemonKeyPair);

    // Send invalid hello
    setTimeout(() => {
      daemonTransport.onmessage?.({ data: '{"type":"invalid"}', isBinary: false });
    }, 0);

    await expect(daemonChannelPromise).rejects.toThrow("Invalid hello message");
  });

  it("accepts duplicate hello from the same client without re-keying", async () => {
    const [daemonTransport, clientTransport] = createMockTransportPair();

    const daemonKeyPair = generateKeyPair();
    const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);
    const daemonMessages: (string | ArrayBuffer)[] = [];

    let clientOpenedResolve: (() => void) | null = null;
    const clientOpened = new Promise<void>((resolve) => {
      clientOpenedResolve = resolve;
    });

    const daemonChannelPromise = createDaemonChannel(daemonTransport, daemonKeyPair, {
      onmessage: (data) => daemonMessages.push(data),
    });

    const clientChannel = await createClientChannel(clientTransport, daemonPubKeyB64, {
      onopen: () => clientOpenedResolve?.(),
    });

    await daemonChannelPromise;
    await clientOpened;

    const firstHello = (clientTransport.send as ReturnType<typeof vi.fn>).mock.calls.find(
      ([data]) => typeof data === "string" && data.includes('"type":"e2ee_hello"'),
    )?.[0];
    expect(typeof firstHello).toBe("string");

    daemonTransport.onmessage?.({ data: firstHello as string, isBinary: false });
    await waitForAsyncDelivery();

    expect(daemonTransport.close).not.toHaveBeenCalled();

    await clientChannel.send("still encrypted with original key");
    await waitForAsyncDelivery();

    expect(daemonMessages).toEqual(["still encrypted with original key"]);
  });

  it("closes an open daemon channel when a different client key sends hello", async () => {
    const [daemonTransport, clientTransport] = createMockTransportPair();

    const daemonKeyPair = generateKeyPair();
    const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);

    let clientOpenedResolve: (() => void) | null = null;
    const clientOpened = new Promise<void>((resolve) => {
      clientOpenedResolve = resolve;
    });

    const daemonChannelPromise = createDaemonChannel(daemonTransport, daemonKeyPair);

    await createClientChannel(clientTransport, daemonPubKeyB64, {
      onopen: () => clientOpenedResolve?.(),
    });

    await daemonChannelPromise;
    await clientOpened;

    const attackerKeyPair = generateKeyPair();
    const attackerHello = JSON.stringify({
      type: "e2ee_hello",
      key: exportPublicKey(attackerKeyPair.publicKey),
    });

    daemonTransport.onmessage?.({ data: attackerHello, isBinary: false });
    await waitForAsyncDelivery();

    expect(daemonTransport.close).toHaveBeenCalledWith(1008, "E2EE re-handshake key mismatch");
  });

  it("preserves ASCII-only binary frames in negotiated mode", async () => {
    const [daemonTransport, clientTransport] = createMockTransportPair();
    const daemonKeyPair = generateKeyPair();
    const daemonMessages: (string | ArrayBuffer)[] = [];
    let resolveOpen: (() => void) | null = null;
    const opened = new Promise<void>((resolve) => {
      resolveOpen = resolve;
    });

    const daemonChannelPromise = createDaemonChannel(daemonTransport, daemonKeyPair, {
      onmessage: (data) => daemonMessages.push(data),
    });
    const clientChannel = await createClientChannel(
      clientTransport,
      exportPublicKey(daemonKeyPair.publicKey),
      { onopen: () => resolveOpen?.() },
    );
    await daemonChannelPromise;
    await opened;

    const binary = new TextEncoder().encode("ASCII terminal output").buffer;
    (clientTransport.send as ReturnType<typeof vi.fn>).mockClear();
    await clientChannel.send(binary);
    await waitForAsyncDelivery();

    const ciphertext = (clientTransport.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(ciphertext).toBeInstanceOf(ArrayBuffer);
    expect((ciphertext as ArrayBuffer).byteLength).toBe(binary.byteLength + 41);
    expect(daemonMessages[0]).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(daemonMessages[0] as ArrayBuffer)).toEqual(new Uint8Array(binary));
  });

  it("new client keeps text as base64 text frames for a binaryCiphertext-only daemon", async () => {
    const daemonKeyPair = generateKeyPair();
    const clientTransport: Transport = {
      send: vi.fn(),
      close: vi.fn(),
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    const clientMessages: (string | ArrayBuffer)[] = [];
    let resolveOpen: (() => void) | null = null;
    const opened = new Promise<void>((resolve) => {
      resolveOpen = resolve;
    });
    const clientChannel = await createClientChannel(
      clientTransport,
      exportPublicKey(daemonKeyPair.publicKey),
      {
        onopen: () => resolveOpen?.(),
        onmessage: (data) => clientMessages.push(data),
      },
    );
    const hello = JSON.parse(sentFrames(clientTransport)[0] as string) as { key: string };
    expect(hello).toMatchObject({
      capabilities: { binaryCiphertext: true, deflatePayloads: true },
    });
    const sharedKey = deriveSharedKey(daemonKeyPair.secretKey, importPublicKey(hello.key));
    await openClientWithReady(clientTransport, opened, { binaryCiphertext: true });

    (clientTransport.send as ReturnType<typeof vi.fn>).mockClear();
    const largeText = compressibleText(8 * 1024);
    await clientChannel.send("text payload");
    await clientChannel.send(largeText);
    await clientChannel.send(new Uint8Array([1, 2, 3]).buffer);

    const [smallFrame, largeFrame, binaryFrame] = sentFrames(clientTransport);
    expect(typeof smallFrame).toBe("string");
    expect(typeof largeFrame).toBe("string");
    expect(binaryFrame).toBeInstanceOf(ArrayBuffer);
    // Plaintext is exactly the application text: no framing header, no compression.
    expect(decodeUtf8(decrypt(sharedKey, base64ToArrayBuffer(largeFrame as string)))).toBe(
      largeText,
    );
    expect(Array.from(new Uint8Array(decrypt(sharedKey, binaryFrame as ArrayBuffer)))).toEqual([
      1, 2, 3,
    ]);

    clientTransport.onmessage?.({
      data: arrayBufferToBase64(encrypt(sharedKey, largeText)),
      isBinary: false,
    });
    clientTransport.onmessage?.({ data: encrypt(sharedKey, new ArrayBuffer(2)), isBinary: true });
    await waitForAsyncDelivery();
    expect(clientMessages[0]).toBe(largeText);
    expect(clientMessages[1]).toBeInstanceOf(ArrayBuffer);
    expect(clientTransport.close).not.toHaveBeenCalled();
  });

  it("new client stays base64-only when an old daemon does not accept the capability", async () => {
    const daemonKeyPair = generateKeyPair();
    const clientTransport: Transport = {
      send: vi.fn(),
      close: vi.fn(),
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    let resolveOpen: (() => void) | null = null;
    const opened = new Promise<void>((resolve) => {
      resolveOpen = resolve;
    });
    const clientChannel = await createClientChannel(
      clientTransport,
      exportPublicKey(daemonKeyPair.publicKey),
      { onopen: () => resolveOpen?.() },
    );

    const hello = JSON.parse(
      (clientTransport.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string,
    ) as { key: string };
    expect(hello).toMatchObject({ capabilities: { binaryCiphertext: true } });
    clientTransport.onmessage?.({ data: JSON.stringify({ type: "e2ee_ready" }), isBinary: false });
    await opened;

    (clientTransport.send as ReturnType<typeof vi.fn>).mockClear();
    await clientChannel.send(new TextEncoder().encode("legacy binary").buffer);
    expect(typeof (clientTransport.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      "string",
    );
  });

  it("new daemon stays base64-only for an old client and drains pipelined traffic", async () => {
    const daemonKeyPair = generateKeyPair();
    const clientKeyPair = generateKeyPair();
    const daemonMessages: (string | ArrayBuffer)[] = [];
    const daemonTransport: Transport = {
      send: vi.fn(),
      close: vi.fn(),
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    const channelPromise = createDaemonChannel(daemonTransport, daemonKeyPair, {
      onmessage: (data) => daemonMessages.push(data),
    });
    const sharedKey = deriveSharedKey(
      clientKeyPair.secretKey,
      importPublicKey(exportPublicKey(daemonKeyPair.publicKey)),
    );
    daemonTransport.onmessage?.({
      data: JSON.stringify({
        type: "e2ee_hello",
        key: exportPublicKey(clientKeyPair.publicKey),
      }),
      isBinary: false,
    });
    daemonTransport.onmessage?.({
      data: arrayBufferToBase64(encrypt(sharedKey, "pipelined legacy text")),
      isBinary: false,
    });

    const daemonChannel = await channelPromise;
    await waitForAsyncDelivery();
    expect(daemonMessages).toEqual(["pipelined legacy text"]);
    expect(
      JSON.parse((daemonTransport.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]),
    ).toEqual({
      type: "e2ee_ready",
    });

    (daemonTransport.send as ReturnType<typeof vi.fn>).mockClear();
    await daemonChannel.send(new Uint8Array([1, 2, 3]).buffer);
    expect(typeof (daemonTransport.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      "string",
    );
  });
});

describe("EncryptedChannel deflatePayloads", () => {
  async function openNegotiatedPair() {
    const [daemonTransport, clientTransport] = createMockTransportPair();
    const daemonKeyPair = generateKeyPair();
    const daemonMessages: (string | ArrayBuffer)[] = [];
    const clientMessages: (string | ArrayBuffer)[] = [];
    let resolveOpen: (() => void) | null = null;
    const opened = new Promise<void>((resolve) => {
      resolveOpen = resolve;
    });
    const daemonChannelPromise = createDaemonChannel(daemonTransport, daemonKeyPair, {
      onmessage: (data) => daemonMessages.push(data),
    });
    const clientChannel = await createClientChannel(
      clientTransport,
      exportPublicKey(daemonKeyPair.publicKey),
      { onopen: () => resolveOpen?.(), onmessage: (data) => clientMessages.push(data) },
    );
    const daemonChannel = await daemonChannelPromise;
    await opened;
    return {
      daemonTransport,
      clientTransport,
      daemonChannel,
      clientChannel,
      daemonMessages,
      clientMessages,
    };
  }

  it("negotiates when both peers advertise it and round-trips every payload kind", async () => {
    const pair = await openNegotiatedPair();
    const ready = sentFrames(pair.daemonTransport)[0];
    expect(JSON.parse(ready as string)).toEqual({
      type: "e2ee_ready",
      capabilities: { binaryCiphertext: true, deflatePayloads: true },
    });

    const large = `héllo wörld ✓ ${compressibleText(64 * 1024)}`;
    const binary = new Uint8Array([0, 1, 2, 255]).buffer;
    (pair.clientTransport.send as ReturnType<typeof vi.fn>).mockClear();
    (pair.daemonTransport.send as ReturnType<typeof vi.fn>).mockClear();
    await pair.clientChannel.send("small ✓");
    await pair.clientChannel.send(large);
    await pair.clientChannel.send(binary);
    await pair.daemonChannel.send(large);
    await waitForAsyncDelivery();

    for (const frame of [
      ...sentFrames(pair.clientTransport),
      ...sentFrames(pair.daemonTransport),
    ]) {
      expect(frame).toBeInstanceOf(ArrayBuffer);
    }
    const [smallFrame, largeFrame] = sentFrames(pair.clientTransport) as ArrayBuffer[];
    expect(smallFrame.byteLength).toBe(new TextEncoder().encode("small ✓").byteLength + 41);
    expect(largeFrame.byteLength).toBeLessThan(large.length / 4);

    expect(pair.daemonMessages.slice(0, 2)).toEqual(["small ✓", large]);
    expect(pair.daemonMessages[2]).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(pair.daemonMessages[2] as ArrayBuffer)).toEqual(new Uint8Array(binary));
    expect(pair.clientMessages).toEqual([large]);
  });

  it("compresses text from the threshold up and leaves smaller text uncompressed", async () => {
    const pair = createFramedPair();
    const below = compressibleText(DEFLATE_TEXT_MIN_BYTES - 1);
    const atThreshold = compressibleText(DEFLATE_TEXT_MIN_BYTES);

    await pair.sender.send(below);
    const belowPlaintext = lastFramedPlaintext(pair);
    expect(belowPlaintext[0]).toBe(0x01);
    expect(belowPlaintext.byteLength).toBe(DEFLATE_TEXT_MIN_BYTES);

    await pair.sender.send(atThreshold);
    const atPlaintext = lastFramedPlaintext(pair);
    expect(atPlaintext[0]).toBe(0x02);
    expect(new DataView(atPlaintext.buffer).getUint32(1, true)).toBe(DEFLATE_TEXT_MIN_BYTES);
    expect(atPlaintext.byteLength).toBeLessThan(DEFLATE_TEXT_MIN_BYTES / 2);

    await waitForAsyncDelivery();
    expect(pair.received).toEqual([below, atThreshold]);
  });

  it("sends large base64-heavy text uncompressed and still compresses large JSON", async () => {
    const pair = createFramedPair();
    // Random bytes never deflate below the probe ratio, like JPEG data.
    const randomBytes = crypto.getRandomValues(new Uint8Array(COMPRESSIBILITY_PROBE_MIN_BYTES));
    const upload = JSON.stringify({
      type: "send_agent_message_request",
      text: "look at this",
      images: [{ mimeType: "image/jpeg", data: arrayBufferToBase64(randomBytes.buffer) }],
    });
    const page = compressibleText(COMPRESSIBILITY_PROBE_MIN_BYTES * 2);

    await pair.sender.send(upload);
    const uploadPlaintext = lastFramedPlaintext(pair);
    expect(uploadPlaintext[0]).toBe(0x01);
    expect(uploadPlaintext.byteLength).toBe(new TextEncoder().encode(upload).byteLength + 1);

    await pair.sender.send(page);
    expect(lastFramedPlaintext(pair)[0]).toBe(0x02);

    await waitForAsyncDelivery();
    expect(pair.received).toEqual([upload, page]);
  });

  it("reports an upper bound for outbound wire bytes", async () => {
    const pair = createFramedPair();
    const large = compressibleText(16 * 1024);
    expect(pair.sender.outboundWireByteLength("abc")).toBe(3 + 41);
    expect(pair.sender.outboundWireByteLength(new ArrayBuffer(10))).toBe(10 + 41);
    await pair.sender.send(large);
    const frame = sentFrames(pair.senderTransport)[0] as ArrayBuffer;
    expect(frame.byteLength).toBeLessThan(pair.sender.outboundWireByteLength(large));
  });

  it("preserves the order of mixed text, compressed text and binary sends", async () => {
    const pair = createFramedPair();
    const large = (seq: number) => `${seq}:${compressibleText(4096)}`;
    const sends: Array<string | ArrayBuffer> = [
      "a",
      large(1),
      new Uint8Array([7]).buffer,
      large(2),
      "b",
      new Uint8Array([8]).buffer,
      large(3),
    ];
    await Promise.all(sends.map((data) => pair.sender.send(data)));
    await waitForAsyncDelivery();

    expect(
      pair.received.map((data) =>
        typeof data === "string" ? data : Array.from(new Uint8Array(data)),
      ),
    ).toEqual(["a", large(1), [7], large(2), "b", [8], large(3)]);
  });

  it("re-sent ready after a duplicate hello keeps the negotiated capabilities", async () => {
    const pair = await openNegotiatedPair();
    const hello = sentFrames(pair.clientTransport).find(
      (data) => typeof data === "string" && data.includes('"type":"e2ee_hello"'),
    );
    (pair.daemonTransport.send as ReturnType<typeof vi.fn>).mockClear();

    pair.daemonTransport.onmessage?.({ data: hello as string, isBinary: false });
    await waitForAsyncDelivery();

    expect(JSON.parse(sentFrames(pair.daemonTransport)[0] as string)).toEqual({
      type: "e2ee_ready",
      capabilities: { binaryCiphertext: true, deflatePayloads: true },
    });
    const large = compressibleText(8 * 1024);
    await pair.clientChannel.send(large);
    await pair.daemonChannel.send(large);
    await waitForAsyncDelivery();
    expect(pair.daemonMessages).toEqual([large]);
    expect(pair.clientMessages).toEqual([large]);
    expect(pair.daemonTransport.close).not.toHaveBeenCalled();
    expect(pair.clientTransport.close).not.toHaveBeenCalled();
  });

  it("new daemon keeps today's wire format for a binaryCiphertext-only client", async () => {
    const daemonKeyPair = generateKeyPair();
    const clientKeyPair = generateKeyPair();
    const daemonMessages: (string | ArrayBuffer)[] = [];
    const daemonTransport: Transport = {
      send: vi.fn(),
      close: vi.fn(),
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    const channelPromise = createDaemonChannel(daemonTransport, daemonKeyPair, {
      onmessage: (data) => daemonMessages.push(data),
    });
    const sharedKey = deriveSharedKey(clientKeyPair.secretKey, daemonKeyPair.publicKey);
    daemonTransport.onmessage?.({
      data: JSON.stringify({
        type: "e2ee_hello",
        key: exportPublicKey(clientKeyPair.publicKey),
        capabilities: { binaryCiphertext: true },
      }),
      isBinary: false,
    });
    const daemonChannel = await channelPromise;
    expect(JSON.parse(sentFrames(daemonTransport)[0] as string)).toEqual({
      type: "e2ee_ready",
      capabilities: { binaryCiphertext: true },
    });

    const large = compressibleText(8 * 1024);
    daemonTransport.onmessage?.({
      data: arrayBufferToBase64(encrypt(sharedKey, large)),
      isBinary: false,
    });
    daemonTransport.onmessage?.({ data: encrypt(sharedKey, new ArrayBuffer(3)), isBinary: true });
    await waitForAsyncDelivery();
    expect(daemonMessages[0]).toBe(large);
    expect(daemonMessages[1]).toBeInstanceOf(ArrayBuffer);

    (daemonTransport.send as ReturnType<typeof vi.fn>).mockClear();
    await daemonChannel.send(large);
    await daemonChannel.send(new Uint8Array([4, 5]).buffer);
    const [textFrame, binaryFrame] = sentFrames(daemonTransport);
    expect(typeof textFrame).toBe("string");
    expect(decodeUtf8(decrypt(sharedKey, base64ToArrayBuffer(textFrame as string)))).toBe(large);
    expect(Array.from(new Uint8Array(decrypt(sharedKey, binaryFrame as ArrayBuffer)))).toEqual([
      4, 5,
    ]);
    expect(daemonTransport.close).not.toHaveBeenCalled();
  });

  it("does not negotiate deflatePayloads without binaryCiphertext", async () => {
    const daemonKeyPair = generateKeyPair();
    const clientKeyPair = generateKeyPair();
    const daemonTransport: Transport = {
      send: vi.fn(),
      close: vi.fn(),
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    const channelPromise = createDaemonChannel(daemonTransport, daemonKeyPair);
    daemonTransport.onmessage?.({
      data: JSON.stringify({
        type: "e2ee_hello",
        key: exportPublicKey(clientKeyPair.publicKey),
        capabilities: { deflatePayloads: true },
      }),
      isBinary: false,
    });
    const daemonChannel = await channelPromise;
    expect(JSON.parse(sentFrames(daemonTransport)[0] as string)).toEqual({ type: "e2ee_ready" });

    (daemonTransport.send as ReturnType<typeof vi.fn>).mockClear();
    await daemonChannel.send(compressibleText(4096));
    expect(typeof sentFrames(daemonTransport)[0]).toBe("string");
  });

  it.each([
    {
      name: "a declared inflated size above the limit",
      frame: () => deflateFrame(MAX_INFLATED_TEXT_BYTES + 1, "x"),
      reason: /above the 33554432 byte limit/,
    },
    {
      name: "a stream that inflates past its declared size",
      frame: () => deflateFrame(1024, compressibleText(4096)),
      reason: /inflated to 1025 bytes, expected 1024/,
    },
    {
      name: "a stream that ends before its declared size",
      frame: () => deflateFrame(8192, compressibleText(4096)),
      reason: /inflated to 4096 bytes, expected 8192/,
    },
    {
      name: "an unknown kind header",
      frame: () => new Uint8Array([0x7f, 1, 2]).buffer,
      reason: /Unknown framed plaintext kind 127/,
    },
    {
      name: "an empty plaintext",
      frame: () => new ArrayBuffer(0),
      reason: /missing its kind header/,
    },
  ])("closes the channel on $name", async ({ frame, reason }) => {
    const pair = createFramedPair();
    pair.receiverTransport.onmessage?.({
      data: encrypt(pair.sharedKey, frame()),
      isBinary: true,
    });
    await waitForAsyncDelivery();

    expect(pair.received).toEqual([]);
    expect(pair.receiverTransport.close).toHaveBeenCalledWith(1011, expect.stringMatching(reason));
  });
});
