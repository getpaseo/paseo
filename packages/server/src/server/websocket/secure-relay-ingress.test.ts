import { afterEach, expect, test, vi } from "vitest";
import pino from "pino";
import {
  createClientChannel,
  exportPublicKey,
  generateKeyPair,
  openClientSecureChannel,
} from "@getpaseo/relay/e2ee";
import type { Transport } from "@getpaseo/relay/e2ee";
import { admitSecuredRelaySocket, type SecuredRelaySocket } from "./secure-relay-ingress.js";

type Listener = (...args: unknown[]) => void;

class FakeIngressSocket {
  readyState = 1;
  bufferedAmount = 0;
  terminateCalls = 0;
  closes: Array<{ code?: number; reason?: string }> = [];
  deferSendCompletion = false;
  onSend: ((data: string | Uint8Array | ArrayBuffer) => void) | null = null;
  private pendingSendCallbacks: Array<(error?: Error) => void> = [];
  private listeners = new Map<string, Listener[]>();

  on(event: "message" | "close" | "error", listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  send(data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void) {
    this.onSend?.(data);
    if (!callback) return;
    if (this.deferSendCompletion) {
      this.pendingSendCallbacks.push(callback);
      return;
    }
    callback();
  }

  completeNextSend() {
    this.pendingSendCallbacks.shift()?.();
  }

  close(code?: number, reason?: string) {
    this.closes.push({ code, reason });
    this.readyState = 3;
  }

  terminate() {
    this.terminateCalls += 1;
    this.readyState = 3;
    this.emit("close", 1006, "");
  }

  message(data: string | ArrayBuffer) {
    this.emit("message", data, data instanceof ArrayBuffer);
  }

  private emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

const logger = pino({ level: "silent" });
const allowLegacy = { requireProtectedMode: () => false };

/** Wires a client secure channel to the fake socket so both ends talk directly. */
async function openClientAgainst(
  socket: FakeIngressSocket,
  daemonPublicKeyB64: string,
  events: { onopen?: () => void; onmessage?: (data: string | ArrayBuffer) => void } = {},
) {
  const clientTransport: Transport = {
    send: (data) => socket.message(data),
    close: () => undefined,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  socket.onSend = (data) => {
    clientTransport.onmessage?.({
      data: data instanceof Uint8Array ? data.slice().buffer : data,
      isBinary: data instanceof ArrayBuffer || data instanceof Uint8Array,
    });
  };
  return openClientSecureChannel(clientTransport, { daemonPublicKeyB64, events });
}

/** An older client that only speaks the legacy construction. */
async function openLegacyClientAgainst(socket: FakeIngressSocket, daemonPublicKeyB64: string) {
  const clientTransport: Transport = {
    send: (data) => socket.message(data),
    close: () => undefined,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  socket.onSend = (data) => {
    clientTransport.onmessage?.({
      data: data instanceof Uint8Array ? data.slice().buffer : data,
      isBinary: data instanceof ArrayBuffer || data instanceof Uint8Array,
    });
  };
  return createClientChannel(clientTransport, daemonPublicKeyB64);
}

afterEach(() => {
  vi.useRealTimers();
});

test("terminates a relay socket whose peer never completes the handshake", async () => {
  vi.useFakeTimers();
  const socket = new FakeIngressSocket();
  let attachments = 0;
  const admitted = admitSecuredRelaySocket(
    socket,
    { daemonKeyPair: generateKeyPair(), logger, ...allowLegacy },
    async () => {
      attachments += 1;
    },
  );
  await vi.advanceTimersByTimeAsync(15_000);
  await admitted;
  expect(socket.terminateCalls).toBe(1);
  expect(attachments).toBe(0);
});

test("admits the secured socket with its negotiated security mode", async () => {
  const socket = new FakeIngressSocket();
  const daemonKeyPair = generateKeyPair();
  let secured: SecuredRelaySocket | null = null;
  const admitted = admitSecuredRelaySocket(
    socket,
    { daemonKeyPair, logger, ...allowLegacy },
    async (next) => {
      secured = next;
    },
  );
  await openClientAgainst(socket, exportPublicKey(daemonKeyPair.publicKey));
  await admitted;
  expect(secured).not.toBeNull();
  expect(secured!.securityMode).toBe("protected");
  expect(secured!.socket.readyState).toBe(1);
});

test("admits a legacy client while protected mode is not required", async () => {
  const socket = new FakeIngressSocket();
  const daemonKeyPair = generateKeyPair();
  let secured: SecuredRelaySocket | null = null;
  const admitted = admitSecuredRelaySocket(
    socket,
    { daemonKeyPair, logger, ...allowLegacy },
    async (next) => {
      secured = next;
    },
  );
  await openLegacyClientAgainst(socket, exportPublicKey(daemonKeyPair.publicKey));
  await admitted;
  expect(secured!.securityMode).toBe("legacy");
});

test("rejects a legacy client with a policy close when protected mode is required", async () => {
  const socket = new FakeIngressSocket();
  const daemonKeyPair = generateKeyPair();
  let attachments = 0;
  const admitted = admitSecuredRelaySocket(
    socket,
    { daemonKeyPair, logger, requireProtectedMode: () => true },
    async () => {
      attachments += 1;
    },
  );
  await openLegacyClientAgainst(socket, exportPublicKey(daemonKeyPair.publicKey));
  await admitted;
  expect(attachments).toBe(0);
  expect(socket.closes).toEqual([{ code: 1008, reason: "protected endpoint security required" }]);
});

test("reads the policy when the hello arrives, not when the socket was accepted", async () => {
  const socket = new FakeIngressSocket();
  const daemonKeyPair = generateKeyPair();
  let required = false;
  let attachments = 0;
  const admitted = admitSecuredRelaySocket(
    socket,
    { daemonKeyPair, logger, requireProtectedMode: () => required },
    async () => {
      attachments += 1;
    },
  );
  required = true;
  await openLegacyClientAgainst(socket, exportPublicKey(daemonKeyPair.publicKey));
  await admitted;
  expect(attachments).toBe(0);
  expect(socket.closes[0]?.code).toBe(1008);
});

test("delivers records received before admission completes, in order, after attach", async () => {
  const socket = new FakeIngressSocket();
  const daemonKeyPair = generateKeyPair();
  let releaseAttach: (() => void) | undefined;
  const attachGate = new Promise<void>((resolve) => {
    releaseAttach = resolve;
  });
  const received: unknown[] = [];
  let secured: SecuredRelaySocket | null = null;
  const admitted = admitSecuredRelaySocket(
    socket,
    { daemonKeyPair, logger, ...allowLegacy },
    async (next) => {
      secured = next;
      next.socket.on("message", (data) => received.push(data));
      await attachGate;
    },
  );
  let clientOpen: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    clientOpen = resolve;
  });
  const client = await openClientAgainst(socket, exportPublicKey(daemonKeyPair.publicKey), {
    onopen: () => clientOpen(),
  });
  await opened;
  await vi.waitFor(() => expect(secured).not.toBeNull());
  await client.send("first");
  await client.send("second");
  expect(received).toEqual([]);
  releaseAttach?.();
  await admitted;
  expect(received).toEqual(["first", "second"]);
});

test("encrypted sends wait for the physical socket send callback", async () => {
  const socket = new FakeIngressSocket();
  const daemonKeyPair = generateKeyPair();
  socket.deferSendCompletion = true;
  let resolveAttached: ((secured: SecuredRelaySocket) => void) | undefined;
  const attached = new Promise<SecuredRelaySocket>((resolve) => {
    resolveAttached = resolve;
  });
  void admitSecuredRelaySocket(socket, { daemonKeyPair, logger, ...allowLegacy }, async (next) =>
    resolveAttached?.(next),
  );
  let resolveClientOpen: (() => void) | undefined;
  const clientOpen = new Promise<void>((resolve) => {
    resolveClientOpen = resolve;
  });
  await openClientAgainst(socket, exportPublicKey(daemonKeyPair.publicKey), {
    onopen: () => resolveClientOpen?.(),
  });

  let attachedCompleted = false;
  void attached.then(() => {
    attachedCompleted = true;
    return undefined;
  });
  await clientOpen;
  await Promise.resolve();
  expect(attachedCompleted).toBe(false);
  socket.completeNextSend();
  const { socket: encryptedSocket } = await attached;

  let completed = false;
  const sending = Promise.resolve(encryptedSocket.send(new Uint8Array([1, 2, 3]))).then(() => {
    completed = true;
    return undefined;
  });
  await Promise.resolve();
  expect(completed).toBe(false);

  socket.completeNextSend();
  await sending;
  expect(completed).toBe(true);
});
