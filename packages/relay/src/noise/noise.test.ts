import { describe, expect, test } from "vitest";
import {
  CipherState,
  createNoiseInitiator,
  createNoiseResponder,
  generateNoiseKeyPair,
  NoiseProtocolError,
  NOISE_NK_PROTOCOL_NAME,
} from "./index.js";
import vectors from "./fixtures/nk-25519-chachapoly-sha256.json" with { type: "json" };
import { x25519 } from "@noble/curves/ed25519.js";

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
function fromHex(hexText: string): Uint8Array {
  return new Uint8Array(Buffer.from(hexText, "hex"));
}
function keyPairFromSecret(secretHex: string) {
  const secretKey = fromHex(secretHex);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

describe(NOISE_NK_PROTOCOL_NAME, () => {
  for (const vector of vectors.vectors) {
    test(`matches vector from ${vector.source}`, () => {
      expect(vector.name).toBe(NOISE_NK_PROTOCOL_NAME);
      const responderStatic = keyPairFromSecret(vector.resp_static);
      expect(hex(responderStatic.publicKey)).toBe(vector.init_remote_static);
      const initiator = createNoiseInitiator({
        remoteStatic: fromHex(vector.init_remote_static),
        prologue: fromHex(vector.init_prologue),
        ephemeral: keyPairFromSecret(vector.init_ephemeral),
      });
      const responder = createNoiseResponder({
        localStatic: responderStatic,
        prologue: fromHex(vector.resp_prologue),
        ephemeral: keyPairFromSecret(vector.resp_ephemeral),
      });

      const [m1, m2, ...transport] = vector.messages;
      const msg1 = initiator.writeMessage(fromHex(m1.payload));
      expect(hex(msg1)).toBe(m1.ciphertext);
      expect(hex(responder.readMessage(msg1))).toBe(m1.payload);
      const msg2 = responder.writeMessage(fromHex(m2.payload));
      expect(hex(msg2)).toBe(m2.ciphertext);
      expect(hex(initiator.readMessage(msg2))).toBe(m2.payload);
      expect(initiator.isComplete()).toBe(true);
      expect(responder.isComplete()).toBe(true);
      if ("handshake_hash" in vector) {
        expect(hex(initiator.handshakeHash())).toBe(vector.handshake_hash);
        expect(hex(responder.handshakeHash())).toBe(vector.handshake_hash);
      }

      const initiatorKeys = initiator.split();
      const responderKeys = responder.split();
      const empty = new Uint8Array(0);
      transport.forEach((message, index) => {
        const fromInitiator = index % 2 === 0;
        const sender = fromInitiator ? initiatorKeys.send : responderKeys.send;
        const receiver = fromInitiator ? responderKeys.receive : initiatorKeys.receive;
        const ciphertext = sender.encryptWithAd(empty, fromHex(message.payload));
        expect(hex(ciphertext)).toBe(message.ciphertext);
        expect(hex(receiver.decryptWithAd(empty, ciphertext))).toBe(message.payload);
      });
    });
  }

  test("rejects a replayed, reflected, or out-of-order transport message", () => {
    const daemon = generateNoiseKeyPair();
    const prologue = new TextEncoder().encode("test");
    const initiator = createNoiseInitiator({ remoteStatic: daemon.publicKey, prologue });
    const responder = createNoiseResponder({ localStatic: daemon, prologue });
    const empty = new Uint8Array(0);
    responder.readMessage(initiator.writeMessage(empty));
    initiator.readMessage(responder.writeMessage(empty));
    const client = initiator.split();
    const server = responder.split();

    const first = client.send.encryptWithAd(empty, new Uint8Array([1]));
    const second = client.send.encryptWithAd(empty, new Uint8Array([2]));
    expect(server.receive.decryptWithAd(empty, first)).toEqual(new Uint8Array([1]));
    // duplicate
    expect(() => server.receive.decryptWithAd(empty, first)).toThrow(NoiseProtocolError);
    // a failed attempt did not advance the counter: the genuine next record still decrypts
    expect(server.receive.decryptWithAd(empty, second)).toEqual(new Uint8Array([2]));
    // reflection: a record the client sent, handed back to the client
    expect(() => client.receive.decryptWithAd(empty, second)).toThrow(NoiseProtocolError);
    // out of order
    const third = client.send.encryptWithAd(empty, new Uint8Array([3]));
    const fourth = client.send.encryptWithAd(empty, new Uint8Array([4]));
    expect(() => server.receive.decryptWithAd(empty, fourth)).toThrow(NoiseProtocolError);
    expect(server.receive.decryptWithAd(empty, third)).toEqual(new Uint8Array([3]));
    expect(server.receive.decryptWithAd(empty, fourth)).toEqual(new Uint8Array([4]));
  });

  test("a recorded first message cannot derive the keys of a fresh responder", () => {
    const daemon = generateNoiseKeyPair();
    const prologue = new TextEncoder().encode("test");
    const empty = new Uint8Array(0);
    const initiator = createNoiseInitiator({ remoteStatic: daemon.publicKey, prologue });
    const msg1 = initiator.writeMessage(empty);
    const original = createNoiseResponder({ localStatic: daemon, prologue });
    original.readMessage(msg1);
    initiator.readMessage(original.writeMessage(empty));
    const clientKeys = initiator.split();
    const record = clientKeys.send.encryptWithAd(empty, new Uint8Array([7]));

    const replayTarget = createNoiseResponder({ localStatic: daemon, prologue });
    replayTarget.readMessage(msg1);
    replayTarget.writeMessage(empty);
    const replayKeys = replayTarget.split();
    expect(() => replayKeys.receive.decryptWithAd(empty, record)).toThrow(NoiseProtocolError);
  });

  test("rejects a low-order remote ephemeral and a wrong responder key", () => {
    const daemon = generateNoiseKeyPair();
    const prologue = new TextEncoder().encode("test");
    const empty = new Uint8Array(0);
    const responder = createNoiseResponder({ localStatic: daemon, prologue });
    const zeroEphemeral = new Uint8Array(32 + 16);
    expect(() => responder.readMessage(zeroEphemeral)).toThrow(NoiseProtocolError);

    const other = generateNoiseKeyPair();
    const initiator = createNoiseInitiator({ remoteStatic: other.publicKey, prologue });
    const victim = createNoiseResponder({ localStatic: daemon, prologue });
    expect(() => victim.readMessage(initiator.writeMessage(empty))).toThrow(NoiseProtocolError);
  });

  test("stops at the last nonce in both directions and keeps state on a failed tag", () => {
    const MAX = (1n << 64n) - 1n;
    const key = new Uint8Array(32).map((_, i) => i + 1);
    const ad = new Uint8Array(0);
    const sender = new CipherState();
    const receiver = new CipherState();
    sender.initializeKey(key.slice(), MAX - 1n);
    receiver.initializeKey(key.slice(), MAX - 1n);
    const last = sender.encryptWithAd(ad, new Uint8Array([1, 2, 3]));
    expect(sender.nonce()).toBe(MAX);
    expect(() => sender.encryptWithAd(ad, new Uint8Array([4]))).toThrow("nonce exhausted");
    expect(sender.nonce()).toBe(MAX);

    const tampered = last.slice();
    tampered[0] ^= 1;
    expect(() => receiver.decryptWithAd(ad, tampered)).toThrow("authentication failed");
    expect(receiver.nonce()).toBe(MAX - 1n);
    expect(Array.from(receiver.decryptWithAd(ad, last))).toEqual([1, 2, 3]);
    expect(receiver.nonce()).toBe(MAX);
    expect(() => receiver.decryptWithAd(ad, last)).toThrow("nonce exhausted");
  });

  test("refuses to proceed out of turn or after completion", () => {
    const daemon = generateNoiseKeyPair();
    const prologue = new Uint8Array(0);
    const empty = new Uint8Array(0);
    const initiator = createNoiseInitiator({ remoteStatic: daemon.publicKey, prologue });
    const responder = createNoiseResponder({ localStatic: daemon, prologue });
    expect(() => responder.writeMessage(empty)).toThrow(NoiseProtocolError);
    expect(() => initiator.split()).toThrow(NoiseProtocolError);
    responder.readMessage(initiator.writeMessage(empty));
    expect(() => initiator.writeMessage(empty)).toThrow(NoiseProtocolError);
    initiator.readMessage(responder.writeMessage(empty));
    expect(() => initiator.readMessage(empty)).toThrow(NoiseProtocolError);
    initiator.split();
    expect(() => initiator.split()).toThrow(NoiseProtocolError);
  });
});
