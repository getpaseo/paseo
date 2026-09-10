import { EventEmitter, once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { expect, test } from "vitest";
import {
  EncryptedChannel,
  decrypt,
  deriveSharedKey,
  generateKeyPair,
  maxBase64EncryptedPlaintextByteLength,
} from "@getpaseo/relay";
import type { Transport } from "@getpaseo/relay/e2ee";
import { createEncryptedRelaySocket } from "./encrypted-relay-socket.js";
import { MAX_RELAY_PAYLOAD_BYTES } from "./relay-payload.js";

test.each(["binary", "text", "unicode"] as const)(
  "%s relay frames respect the wire ceiling and a new connection recovers",
  async (kind) => {
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      maxPayload: MAX_RELAY_PAYLOAD_BYTES,
    });
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || address === null)
      throw new Error("Missing listener address");
    const clients: WebSocket[] = [];
    const connect = async () => {
      const connected = once(server, "connection");
      const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
      clients.push(client);
      await once(client, "open");
      const [peer] = (await connected) as [WebSocket];
      const emitter = new EventEmitter();
      const transport: Transport = {
        send: (data) =>
          new Promise<void>((resolve, reject) => {
            client.send(data, (error) => {
              if (error) reject(error);
              else resolve();
            });
          }),
        close: (code, reason) => client.close(code, reason),
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      client.on("close", (code, reason) => transport.onclose?.(code, reason.toString()));
      client.on("error", (error) => transport.onerror?.(error));
      const daemonKeys = generateKeyPair();
      const clientKeys = generateKeyPair();
      const sharedKey = deriveSharedKey(daemonKeys.secretKey, clientKeys.publicKey);
      const channel = new EncryptedChannel(
        transport,
        sharedKey,
        {
          onclose: (code, reason) => emitter.emit("close", code, reason),
        },
        { binaryCiphertext: true },
      );
      const socket = createEncryptedRelaySocket({
        channel,
        emitter,
        getTransportBufferedAmount: () => client.bufferedAmount,
        terminateTransport: () => client.terminate(),
      });
      return { client, peer, socket, sharedKey };
    };
    try {
      const { client, peer, socket } = await connect();
      const healthy = await connect();
      const textLimit = maxBase64EncryptedPlaintextByteLength(MAX_RELAY_PAYLOAD_BYTES);
      let payload: string | Uint8Array;
      if (kind === "binary") {
        payload = new Uint8Array(MAX_RELAY_PAYLOAD_BYTES - 40);
      } else if (kind === "unicode") {
        payload = "日".repeat(Math.floor(textLimit / 3)) + "x".repeat(textLimit % 3);
      } else {
        payload = "x".repeat(textLimit);
      }
      const received = once(peer, "message");
      await socket.send(payload);
      const [frame, binary] = (await received) as [Buffer, boolean];
      expect(frame.byteLength).toBe(
        kind === "binary" ? MAX_RELAY_PAYLOAD_BYTES : Math.floor(MAX_RELAY_PAYLOAD_BYTES / 4) * 4,
      );
      expect(binary).toBe(kind === "binary");
      const closed = once(client, "close");
      const tooLarge =
        typeof payload === "string" ? payload + "x" : new Uint8Array(payload.byteLength + 1);
      await expect(socket.send(tooLarge)).rejects.toThrow("relay payload limit");
      await closed;
      expect(socket.readyState).toBe(3);

      const unaffected = once(healthy.peer, "message");
      await healthy.socket.send("still-healthy");
      const [healthyFrame] = (await unaffected) as [Buffer];
      const healthyCiphertext = Uint8Array.from(
        Buffer.from(healthyFrame.toString(), "base64"),
      ).buffer;
      expect(new TextDecoder().decode(decrypt(healthy.sharedKey, healthyCiphertext))).toBe(
        "still-healthy",
      );
      expect(healthy.socket.readyState).toBe(1);

      const replacement = await connect();
      const recovered = once(replacement.peer, "message");
      await replacement.socket.send("recovered");
      const [recoveredFrame] = (await recovered) as [Buffer];
      const ciphertext = Uint8Array.from(Buffer.from(recoveredFrame.toString(), "base64")).buffer;
      expect(new TextDecoder().decode(decrypt(replacement.sharedKey, ciphertext))).toBe(
        "recovered",
      );
      expect(replacement.socket.readyState).toBe(1);
    } finally {
      for (const client of clients) client.terminate();
      for (const peer of server.clients) peer.terminate();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  },
);
