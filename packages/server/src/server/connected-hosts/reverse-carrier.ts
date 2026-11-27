import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  DaemonTransport,
  DaemonTransportFactory,
} from "@getpaseo/client/internal/daemon-client-transport-types";
import {
  MAX_HOST_CHANNEL_FRAME_BYTES,
  MAX_HOST_ROUTE_HEADER_BYTES,
} from "@getpaseo/protocol/binary-frames/index";
import { VirtualHostSocket } from "./link.js";

interface ReverseCarrierIdentity {
  dialerServerId: string;
  acceptorServerId: string;
  token: string;
}

const AUTH_TIMEOUT_MS = 5_000;
const MAX_AUTH_FRAME_BYTES = 256;

// A session frame inside the carrier gains another routing header and another
// JSON wrapper. Leave space for either kind of frame before outer chunking.
function innerFrameBytes(carrierFrameBytes = MAX_HOST_CHANNEL_FRAME_BYTES): number {
  return Math.floor((carrierFrameBytes - MAX_HOST_ROUTE_HEADER_BYTES - 256) / 6);
}
const nonce = () => randomBytes(32).toString("hex");
const isDigest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function readAuthFrame(data: unknown): Record<string, unknown> {
  if (typeof data !== "string" || Buffer.byteLength(data) > MAX_AUTH_FRAME_BYTES)
    throw authenticationError();
  const frame: unknown = JSON.parse(data);
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw authenticationError();
  return frame as Record<string, unknown>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((ready, failed) => {
    resolve = ready;
    reject = failed;
  });
  return { promise, resolve, reject };
}

function authenticationError(): Error {
  return Object.assign(new Error("Reverse host authentication failed"), {
    code: "permission_denied",
  });
}

function proof(
  identity: ReverseCarrierIdentity,
  role: "dialer" | "acceptor",
  challenge: string,
  responseNonce: string,
): Buffer {
  return createHmac("sha256", identity.token)
    .update(
      JSON.stringify([
        "paseo-connected-host-reverse-v1",
        role,
        identity.dialerServerId,
        identity.acceptorServerId,
        challenge,
        responseNonce,
      ]),
    )
    .digest();
}

function verifyProof(received: unknown, expected: Buffer): void {
  if (!isDigest(received) || !timingSafeEqual(Buffer.from(received, "hex"), expected))
    throw authenticationError();
}

/** The dialer authenticates the acceptor before attaching a server endpoint to the carrier. */
export function openReverseCarrier(
  transport: DaemonTransport,
  identity: ReverseCarrierIdentity,
  attach: (socket: VirtualHostSocket) => Promise<void>,
): Promise<VirtualHostSocket> {
  const ready = deferred<VirtualHostSocket>();
  const challenge = nonce();
  let phase: "waitingForOpen" | "waitingForProof" | "attaching" | "open" = "waitingForOpen";
  const cleanups: Array<() => void> = [];
  const timer = setTimeout(fail, AUTH_TIMEOUT_MS);
  timer.unref();
  const socket = new VirtualHostSocket(
    async (data) => transport.send(data),
    (code, reason) => {
      clearTimeout(timer);
      for (const cleanup of cleanups) cleanup();
      ready.reject(authenticationError());
      transport.close(code, reason);
    },
    () => 0,
    (hello) => hello,
    innerFrameBytes(transport.maxFrameBytes),
  );
  function fail(): void {
    socket.close(1008, "Reverse host authentication failed");
  }
  cleanups.push(
    transport.onOpen(() => {
      if (phase !== "waitingForOpen") return;
      phase = "waitingForProof";
      void Promise.resolve()
        .then(() => transport.send(JSON.stringify({ type: "reverse.challenge", nonce: challenge })))
        .catch(fail);
    }),
    transport.onMessage(async (data) => {
      try {
        if (phase === "open") {
          if (typeof data === "string" || data instanceof Uint8Array) socket.feed(data);
          else if (data instanceof ArrayBuffer) socket.feed(new Uint8Array(data));
          else throw authenticationError();
          return;
        }
        if (phase !== "waitingForProof") throw authenticationError();
        phase = "attaching";
        const frame = readAuthFrame(data);
        if (frame.type !== "reverse.response" || !isDigest(frame.nonce))
          throw authenticationError();
        verifyProof(frame.proof, proof(identity, "acceptor", challenge, frame.nonce));
        await attach(socket);
        if (socket.readyState !== 1) return;
        phase = "open";
        await transport.send(
          JSON.stringify({
            type: "reverse.confirmed",
            proof: proof(identity, "dialer", challenge, frame.nonce).toString("hex"),
          }),
        );
        clearTimeout(timer);
        ready.resolve(socket);
      } catch {
        fail();
      }
    }),
    transport.onClose(() => socket.close()),
    transport.onError(() => socket.close(1011, "Reverse host carrier failed")),
  );
  return ready.promise;
}

/** The acceptor exposes a one-use client transport after the dialer proves the shared token. */
export function acceptReverseCarrier(
  socket: VirtualHostSocket,
  identity: ReverseCarrierIdentity,
): Promise<DaemonTransportFactory> {
  const ready = deferred<DaemonTransportFactory>();
  const responseNonce = nonce();
  let challenge: string | undefined;
  let confirmed = false;
  let used = false;
  const messages = new Set<(data: unknown, binary: boolean) => void | Promise<void>>();
  const timer = setTimeout(fail, AUTH_TIMEOUT_MS);
  timer.unref();
  function fail(): void {
    socket.close(1008, "Reverse host authentication failed");
  }
  socket.once("close", () => {
    clearTimeout(timer);
    socket.off("message", onMessage);
    messages.clear();
    ready.reject(authenticationError());
  });
  function onMessage(data: string | Uint8Array): void {
    if (confirmed) {
      void Promise.all(
        [...messages].map(async (handler) => handler(data, typeof data !== "string")),
      ).catch(() => socket.close(1011, "Reverse host carrier failed"));
      return;
    }
    try {
      const frame = readAuthFrame(data);
      if (!challenge) {
        if (frame.type !== "reverse.challenge" || !isDigest(frame.nonce))
          throw authenticationError();
        challenge = frame.nonce;
        void socket
          .send(
            JSON.stringify({
              type: "reverse.response",
              nonce: responseNonce,
              proof: proof(identity, "acceptor", challenge, responseNonce).toString("hex"),
            }),
          )
          .catch(fail);
        return;
      }
      if (frame.type !== "reverse.confirmed") throw authenticationError();
      verifyProof(frame.proof, proof(identity, "dialer", challenge, responseNonce));
      confirmed = true;
      clearTimeout(timer);
      ready.resolve(() => {
        if (used || socket.readyState !== 1) throw new Error("Reverse host carrier is closed");
        used = true;
        return {
          maxFrameBytes: innerFrameBytes(socket.maxFrameBytes),
          supportsDrain: true,
          send: (outbound) => socket.send(outbound),
          close: (code, reason) => socket.close(code, reason),
          onOpen(handler) {
            let active = true;
            queueMicrotask(() => {
              if (active && socket.readyState === 1) handler();
            });
            return () => {
              active = false;
            };
          },
          onMessage(handler) {
            messages.add(handler);
            return () => messages.delete(handler);
          },
          onClose(handler) {
            const onClose = (code: number, reason: string) => handler({ code, reason });
            socket.on("close", onClose);
            return () => socket.off("close", onClose);
          },
          onError() {
            return () => {};
          },
        };
      });
    } catch {
      fail();
    }
  }
  if (socket.readyState === 1) socket.on("message", onMessage);
  else {
    clearTimeout(timer);
    ready.reject(authenticationError());
  }
  return ready.promise;
}
