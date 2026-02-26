import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type pino from "pino";

import {
  generateKeyPair,
  exportPublicKey,
  exportSecretKey,
  importPublicKey,
  importSecretKey,
  type KeyPair,
} from "@junction/relay/e2ee";

const KeyPairSchema = z.object({
  v: z.literal(2),
  publicKeyB64: z.string().min(1),
  secretKeyB64: z.string().min(1),
});

type StoredKeyPair = z.infer<typeof KeyPairSchema>;

const KEYPAIR_FILENAME = "daemon-keypair.json";

export type DaemonKeyPairBundle = {
  keyPair: KeyPair;
  publicKeyB64: string;
};

export async function loadOrCreateDaemonKeyPair(
  junctionHome: string,
  logger?: pino.Logger
): Promise<DaemonKeyPairBundle> {
  const log = logger?.child({ module: "daemon-keypair" });
  const filePath = path.join(junctionHome, KEYPAIR_FILENAME);

  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = KeyPairSchema.parse(JSON.parse(raw)) as StoredKeyPair;

      const publicKey = importPublicKey(parsed.publicKeyB64);
      const secretKey = importSecretKey(parsed.secretKeyB64);
      const publicKeyB64 = exportPublicKey(publicKey);

      log?.info({ filePath }, "Loaded daemon keypair");
      return { keyPair: { publicKey, secretKey }, publicKeyB64 };
    } catch (error) {
      log?.warn({ err: error, filePath }, "Failed to load daemon keypair, regenerating");
    }
  }

  const keyPair = generateKeyPair();
  const publicKeyB64 = exportPublicKey(keyPair.publicKey);
  const secretKeyB64 = exportSecretKey(keyPair.secretKey);

  const payload: StoredKeyPair = {
    v: 2,
    publicKeyB64,
    secretKeyB64,
  };

  writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  log?.info({ filePath }, "Saved daemon keypair");

  return { keyPair, publicKeyB64 };
}

