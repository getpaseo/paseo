import { describe, it, expect } from "vitest";
import {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedKey,
  encrypt,
  decrypt,
} from "./crypto.js";

describe("crypto", () => {
  describe("generateKeyPair", () => {
    it("generates a valid ECDH keypair", async () => {
      const keypair = await generateKeyPair();
      expect(keypair.privateKey).toBeDefined();
      expect(keypair.publicKey).toBeDefined();
    });
  });

  describe("exportPublicKey / importPublicKey", () => {
    it("roundtrips public key through base64", async () => {
      const keypair = await generateKeyPair();
      const exported = await exportPublicKey(keypair.publicKey);

      expect(typeof exported).toBe("string");
      expect(exported.length).toBeGreaterThan(0);

      const imported = await importPublicKey(exported);
      expect(imported).toBeDefined();

      // Re-export should match
      const reExported = await exportPublicKey(imported);
      expect(reExported).toBe(exported);
    });
  });

  describe("deriveSharedKey", () => {
    it("derives the same key on both sides", async () => {
      // Simulate daemon and client
      const daemonKeyPair = await generateKeyPair();
      const clientKeyPair = await generateKeyPair();

      // Export public keys (what would go over the wire)
      const daemonPubKeyB64 = await exportPublicKey(daemonKeyPair.publicKey);
      const clientPubKeyB64 = await exportPublicKey(clientKeyPair.publicKey);

      // Import peer's public key
      const daemonSeesClientPubKey = await importPublicKey(clientPubKeyB64);
      const clientSeesDaemonPubKey = await importPublicKey(daemonPubKeyB64);

      // Derive shared keys
      const daemonSharedKey = await deriveSharedKey(
        daemonKeyPair.privateKey,
        daemonSeesClientPubKey
      );
      const clientSharedKey = await deriveSharedKey(
        clientKeyPair.privateKey,
        clientSeesDaemonPubKey
      );

      // Both should derive the same key - test by encrypting with one, decrypting with other
      const testMessage = "Hello, encrypted world!";
      const encrypted = await encrypt(daemonSharedKey, testMessage);
      const decrypted = await decrypt(clientSharedKey, encrypted);

      expect(decrypted).toBe(testMessage);
    });
  });

  describe("encrypt / decrypt", () => {
    it("roundtrips a string message", async () => {
      const daemonKeyPair = await generateKeyPair();
      const clientKeyPair = await generateKeyPair();
      const sharedKey = await deriveSharedKey(
        daemonKeyPair.privateKey,
        clientKeyPair.publicKey
      );

      const plaintext = "Test message with unicode: 你好世界 🎉";
      const ciphertext = await encrypt(sharedKey, plaintext);

      expect(ciphertext).toBeInstanceOf(ArrayBuffer);
      expect(ciphertext.byteLength).toBeGreaterThan(plaintext.length);

      const decrypted = await decrypt(sharedKey, ciphertext);
      expect(decrypted).toBe(plaintext);
    });

    it("roundtrips binary data", async () => {
      const daemonKeyPair = await generateKeyPair();
      const clientKeyPair = await generateKeyPair();
      const sharedKey = await deriveSharedKey(
        daemonKeyPair.privateKey,
        clientKeyPair.publicKey
      );

      const binary = new Uint8Array([0, 1, 2, 255, 254, 253]);
      const ciphertext = await encrypt(sharedKey, binary.buffer);

      const decrypted = await decrypt(sharedKey, ciphertext);
      expect(new Uint8Array(decrypted as ArrayBuffer)).toEqual(binary);
    });

    it("fails to decrypt with wrong key", async () => {
      const keypair1 = await generateKeyPair();
      const keypair2 = await generateKeyPair();
      const keypair3 = await generateKeyPair();

      const correctKey = await deriveSharedKey(
        keypair1.privateKey,
        keypair2.publicKey
      );
      const wrongKey = await deriveSharedKey(
        keypair1.privateKey,
        keypair3.publicKey
      );

      const ciphertext = await encrypt(correctKey, "secret");

      await expect(decrypt(wrongKey, ciphertext)).rejects.toThrow();
    });

    it("produces different ciphertext for same plaintext (random IV)", async () => {
      const keypair1 = await generateKeyPair();
      const keypair2 = await generateKeyPair();
      const sharedKey = await deriveSharedKey(
        keypair1.privateKey,
        keypair2.publicKey
      );

      const plaintext = "Same message";
      const ciphertext1 = await encrypt(sharedKey, plaintext);
      const ciphertext2 = await encrypt(sharedKey, plaintext);

      // Should be different due to random IV
      const arr1 = new Uint8Array(ciphertext1);
      const arr2 = new Uint8Array(ciphertext2);
      expect(arr1).not.toEqual(arr2);

      // But both should decrypt to same plaintext
      expect(await decrypt(sharedKey, ciphertext1)).toBe(plaintext);
      expect(await decrypt(sharedKey, ciphertext2)).toBe(plaintext);
    });
  });

  describe("full handshake simulation", () => {
    it("simulates complete daemon<->client key exchange", async () => {
      // === DAEMON SIDE (generates session) ===
      const daemonKeyPair = await generateKeyPair();
      const daemonPubKeyB64 = await exportPublicKey(daemonKeyPair.publicKey);

      // QR code would contain: { s: sessionId, k: daemonPubKeyB64, c: [...urls] }

      // === CLIENT SIDE (scans QR) ===
      const clientKeyPair = await generateKeyPair();
      const clientPubKeyB64 = await exportPublicKey(clientKeyPair.publicKey);

      // Client imports daemon's public key from QR
      const daemonPubKeyOnClient = await importPublicKey(daemonPubKeyB64);

      // Client derives shared key
      const clientSharedKey = await deriveSharedKey(
        clientKeyPair.privateKey,
        daemonPubKeyOnClient
      );

      // Client sends hello: { type: "hello", key: clientPubKeyB64 }

      // === DAEMON SIDE (receives hello) ===
      // Daemon imports client's public key from hello message
      const clientPubKeyOnDaemon = await importPublicKey(clientPubKeyB64);

      // Daemon derives shared key
      const daemonSharedKey = await deriveSharedKey(
        daemonKeyPair.privateKey,
        clientPubKeyOnDaemon
      );

      // === VERIFY BOTH HAVE SAME KEY ===
      const testFromDaemon = "Message from daemon";
      const testFromClient = "Message from client";

      // Daemon encrypts, client decrypts
      const encryptedFromDaemon = await encrypt(daemonSharedKey, testFromDaemon);
      expect(await decrypt(clientSharedKey, encryptedFromDaemon)).toBe(
        testFromDaemon
      );

      // Client encrypts, daemon decrypts
      const encryptedFromClient = await encrypt(clientSharedKey, testFromClient);
      expect(await decrypt(daemonSharedKey, encryptedFromClient)).toBe(
        testFromClient
      );
    });
  });
});
