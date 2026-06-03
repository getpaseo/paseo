import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import { describe, expect, test } from "vitest";

import { PRIVATE_FILE_MODE } from "../private-files.js";
import { PushTokenStore } from "./token-store.js";

const MODE_MASK = 0o777;
const PERMISSIVE_FILE_MODE = 0o644;

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
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
      const store = new PushTokenStore(createLogger(), tokenPath);

      store.addToken("ExponentPushToken[test]");

      expect(modeOf(tokenPath)).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("repairs existing push token file permissions when loading", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-tokens-"));
    const tokenPath = path.join(home, "push-tokens.json");
    try {
      writeFileSync(tokenPath, JSON.stringify({ tokens: ["ExponentPushToken[test]"] }));
      chmodSync(tokenPath, PERMISSIVE_FILE_MODE);

      const store = new PushTokenStore(createLogger(), tokenPath);

      expect(store.getAllTokens()).toEqual(["ExponentPushToken[test]"]);
      expect(modeOf(tokenPath)).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("PushTokenStore subscriptions", () => {
  test("loads legacy Expo token files as Expo subscriptions", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-tokens-"));
    const tokenPath = path.join(home, "push-tokens.json");
    try {
      writeFileSync(tokenPath, JSON.stringify({ tokens: [" ExponentPushToken[test] ", "", 42] }));

      const store = new PushTokenStore(createLogger(), tokenPath);

      expect(store.getAllSubscriptions()).toEqual([
        {
          kind: "expo",
          token: "ExponentPushToken[test]",
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
      ]);
      expect(store.getAllTokens()).toEqual(["ExponentPushToken[test]"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("persists versioned Expo and Web Push subscriptions", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-tokens-"));
    const tokenPath = path.join(home, "push-tokens.json");
    try {
      const store = new PushTokenStore(createLogger(), tokenPath);

      store.addToken("ExponentPushToken[test]");
      store.upsertWebPushSubscription({
        kind: "webPush",
        endpoint: "https://push.example.test/subscription/abc",
        keys: { p256dh: "p256dh-key", auth: "auth-secret" },
      });

      const persisted = JSON.parse(readFileSync(tokenPath, "utf-8"));
      expect(persisted).toEqual({
        version: 2,
        subscriptions: [
          {
            kind: "expo",
            token: "ExponentPushToken[test]",
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
          },
          {
            kind: "webPush",
            endpoint: "https://push.example.test/subscription/abc",
            keys: { p256dh: "p256dh-key", auth: "auth-secret" },
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
          },
        ],
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("upserts and removes Web Push subscriptions by endpoint", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-tokens-"));
    const tokenPath = path.join(home, "push-tokens.json");
    try {
      const store = new PushTokenStore(createLogger(), tokenPath);

      store.upsertWebPushSubscription({
        kind: "webPush",
        endpoint: "https://push.example.test/subscription/abc",
        keys: { p256dh: "first-key", auth: "first-auth" },
      });
      store.upsertWebPushSubscription({
        kind: "webPush",
        endpoint: "https://push.example.test/subscription/abc",
        keys: { p256dh: "second-key", auth: "second-auth" },
      });

      expect(store.getAllSubscriptions()).toEqual([
        {
          kind: "webPush",
          endpoint: "https://push.example.test/subscription/abc",
          keys: { p256dh: "second-key", auth: "second-auth" },
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
      ]);

      store.removeWebPushSubscription("https://push.example.test/subscription/abc");
      expect(store.getAllSubscriptions()).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
