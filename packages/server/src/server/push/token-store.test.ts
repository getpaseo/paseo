import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import { describe, expect, test } from "vitest";

import { PRIVATE_FILE_MODE } from "../private-files.js";
import { createPushNotifications } from "./index.js";
import { PushTokenStore } from "./token-store.js";

const MODE_MASK = 0o777;
const PERMISSIVE_FILE_MODE = 0o644;

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return logger as unknown as pino.Logger;
}

function modeOf(filePath: string): number {
  return statSync(filePath).mode & MODE_MASK;
}

describe.skipIf(process.platform === "win32")("PushTokenStore file permissions", () => {
  test("persists push tokens with private permissions", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-tokens-"));
    const tokenPath = path.join(home, "push-tokens.json");
    try {
      const pushNotifications = createPushNotifications({
        logger: createLogger(),
        filePath: tokenPath,
      });

      pushNotifications.renew("ExponentPushToken[test]");

      expect(modeOf(tokenPath)).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("repairs existing push token file permissions when loading", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-tokens-"));
    const tokenPath = path.join(home, "push-tokens.json");
    try {
      writeFileSync(tokenPath, JSON.stringify({ tokens: ["ExponentPushToken[test]"] }));
      chmodSync(tokenPath, PERMISSIVE_FILE_MODE);

      const deliveries: string[][] = [];
      const pushNotifications = createPushNotifications({
        logger: createLogger(),
        filePath: tokenPath,
        deliver: async (tokens) => deliveries.push(tokens),
      });
      await pushNotifications.send({ title: "Agent finished", body: "Done" });

      expect(deliveries).toEqual([["ExponentPushToken[test]"]]);
      expect(modeOf(tokenPath)).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("PushTokenStore persistence", () => {
  test("does not apply a revocation until the updated subscriptions are durable", () => {
    let rejectWrites = false;
    let persisted = "";
    const store = new PushTokenStore(
      createLogger(),
      path.join(tmpdir(), `missing-push-token-store-${process.pid}`, "push-tokens.json"),
      () => Date.parse("2026-08-10T00:00:00.000Z"),
      48 * 60 * 60 * 1000,
      (_filePath, payload) => {
        if (rejectWrites) throw new Error("disk full");
        persisted = String(payload);
      },
    );

    store.renewToken("ExponentPushToken[test]");
    rejectWrites = true;

    expect(() => store.revokeToken("ExponentPushToken[test]")).toThrow("disk full");
    expect(store.getActiveTokens()).toEqual(["ExponentPushToken[test]"]);
    expect(JSON.parse(persisted)).toEqual({
      subscriptions: [
        {
          token: "ExponentPushToken[test]",
          expiresAt: "2026-08-12T00:00:00.000Z",
        },
      ],
    });

    rejectWrites = false;
    store.revokeToken("ExponentPushToken[test]");
    expect(store.getActiveTokens()).toEqual([]);
    expect(JSON.parse(persisted)).toEqual({ subscriptions: [] });
  });
});
