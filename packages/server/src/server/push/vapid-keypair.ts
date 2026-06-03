import { existsSync, readFileSync } from "node:fs";
import type pino from "pino";
import webPush from "web-push";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

export interface VapidKeyPair {
  publicKey: string;
  privateKey: string;
}

function parseVapidKeyPair(value: unknown): VapidKeyPair | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.publicKey !== "string" || record.publicKey.trim().length === 0) {
    return null;
  }
  if (typeof record.privateKey !== "string" || record.privateKey.trim().length === 0) {
    return null;
  }
  return {
    publicKey: record.publicKey.trim(),
    privateKey: record.privateKey.trim(),
  };
}

export function loadOrCreateVapidKeyPair(logger: pino.Logger, filePath: string): VapidKeyPair {
  const child = logger.child({ component: "vapid-keypair" });
  if (existsSync(filePath)) {
    try {
      ensurePrivateFile(filePath);
      const parsed = parseVapidKeyPair(JSON.parse(readFileSync(filePath, "utf-8")));
      if (parsed) return parsed;
      child.warn("VAPID keypair file is malformed; regenerating");
    } catch (error) {
      child.warn({ err: error }, "Failed to load VAPID keypair; regenerating");
    }
  }

  const generated = webPush.generateVAPIDKeys();
  const keyPair = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
  };
  writePrivateFileAtomicSync(filePath, `${JSON.stringify(keyPair, null, 2)}\n`);
  return keyPair;
}
