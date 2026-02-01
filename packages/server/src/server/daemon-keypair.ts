/// <reference lib="dom" />
import { webcrypto } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const KeyPairSchema = z.object({
  v: z.literal(1),
  publicKeyJwk: z.record(z.any()),
  privateKeyJwk: z.record(z.any()),
});

type StoredKeyPair = z.infer<typeof KeyPairSchema>;

type LoggerLike = {
  child(bindings: Record<string, unknown>): LoggerLike;
  info(...args: any[]): void;
  warn(...args: any[]): void;
};

const KEYPAIR_FILENAME = "daemon-keypair.json";
const ECDH_ALGORITHM = { name: "ECDH", namedCurve: "P-256" };

export type DaemonKeyPairBundle = {
  keyPair: CryptoKeyPair;
  publicKeyB64: string;
};

export async function loadOrCreateDaemonKeyPair(
  paseoHome: string,
  logger?: LoggerLike
): Promise<DaemonKeyPairBundle> {
  const log = logger?.child({ module: "daemon-keypair" });
  const filePath = path.join(paseoHome, KEYPAIR_FILENAME);

  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = KeyPairSchema.parse(JSON.parse(raw)) as StoredKeyPair;
      const [publicKey, privateKey] = await Promise.all([
        webcrypto.subtle.importKey("jwk", parsed.publicKeyJwk, ECDH_ALGORITHM, true, []),
        webcrypto.subtle.importKey("jwk", parsed.privateKeyJwk, ECDH_ALGORITHM, true, [
          "deriveBits",
        ]),
      ]);
      const publicKeyB64 = await exportPublicKeyB64(publicKey);
      log?.info({ filePath }, "Loaded daemon keypair");
      return { keyPair: { publicKey, privateKey }, publicKeyB64 };
    } catch (error) {
      log?.warn({ err: error, filePath }, "Failed to load daemon keypair, regenerating");
    }
  }

  const keyPair = (await webcrypto.subtle.generateKey(ECDH_ALGORITHM, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const [publicKeyJwk, privateKeyJwk, publicKeyB64] = await Promise.all([
    webcrypto.subtle.exportKey("jwk", keyPair.publicKey),
    webcrypto.subtle.exportKey("jwk", keyPair.privateKey),
    exportPublicKeyB64(keyPair.publicKey),
  ]);

  const payload: StoredKeyPair = {
    v: 1,
    publicKeyJwk: publicKeyJwk as Record<string, unknown>,
    privateKeyJwk: privateKeyJwk as Record<string, unknown>,
  };

  writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n");
  log?.info({ filePath }, "Saved daemon keypair");

  return { keyPair, publicKeyB64 };
}

async function exportPublicKeyB64(publicKey: CryptoKey): Promise<string> {
  const raw = await webcrypto.subtle.exportKey("raw", publicKey);
  return Buffer.from(new Uint8Array(raw)).toString("base64");
}
