import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import { describe, expect, test } from "vitest";
import { PRIVATE_FILE_MODE } from "../private-files.js";
import { loadOrCreateVapidKeyPair } from "./vapid-keypair.js";

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  };
  return logger as unknown as pino.Logger;
}

describe.skipIf(process.platform === "win32")("VAPID keypair", () => {
  test("creates and reloads a private keypair file", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-vapid-"));
    const filePath = path.join(home, "push-vapid-keypair.json");
    try {
      const first = loadOrCreateVapidKeyPair(createLogger(), filePath);
      const second = loadOrCreateVapidKeyPair(createLogger(), filePath);

      expect(existsSync(filePath)).toBe(true);
      expect(first).toEqual(second);
      expect(first.publicKey.length).toBeGreaterThan(0);
      expect(first.privateKey.length).toBeGreaterThan(0);
      expect(statSync(filePath).mode & 0o777).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
