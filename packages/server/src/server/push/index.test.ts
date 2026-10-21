import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import { createPushNotifications } from "./index.js";

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

describe("push notifications", () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an offline device remains registered after 48 hours", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-notifications-"));
    homes.push(home);
    const filePath = path.join(home, "push-tokens.json");
    let now = Date.parse("2026-08-10T00:00:00.000Z");
    const deliveries: string[][] = [];
    const pushNotifications = createPushNotifications({
      logger: createLogger(),
      filePath,
      now: () => now,
      deliver: async (tokens) => deliveries.push(tokens),
    });

    pushNotifications.renew("ExponentPushToken[offline-device]");
    now += 48 * 60 * 60 * 1000;
    await pushNotifications.send({ title: "Agent finished", body: "Done" });

    expect(deliveries).toEqual([["ExponentPushToken[offline-device]"]]);
    expect(JSON.parse(readFileSync(filePath, "utf8")).subscriptions).toHaveLength(1);
  });

  test("registration survives restart, retains multiple devices, renews and eventually expires", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-notifications-"));
    homes.push(home);
    const filePath = path.join(home, "push-tokens.json");
    let now = Date.parse("2026-08-10T00:00:00.000Z");
    const deliveries: string[][] = [];
    const options = {
      logger: createLogger(),
      filePath,
      now: () => now,
      deliver: async (tokens: string[]) => {
        deliveries.push(tokens);
      },
    };
    createPushNotifications(options).renew("a");
    const restarted = createPushNotifications(options);
    restarted.renew("b");
    now += 100 * 24 * 60 * 60 * 1000;
    restarted.renew("a");
    await restarted.send({ title: "Finished", body: "Done" });
    now += 81 * 24 * 60 * 60 * 1000;
    await createPushNotifications(options).send({ title: "Finished", body: "Done" });
    expect(deliveries).toEqual([["a", "b"], ["a"]]);
  });

  test("migrates an expired v0.11.2 lease without requiring the phone to reconnect", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-notifications-"));
    homes.push(home);
    const filePath = path.join(home, "push-tokens.json");
    writeFileSync(
      filePath,
      JSON.stringify({ subscriptions: [{ token: "phone", expiresAt: "2026-08-12T00:00:00Z" }] }),
    );
    const deliveries: string[][] = [];
    const push = createPushNotifications({
      logger: createLogger(),
      filePath,
      now: () => Date.parse("2026-08-14T00:00:00Z"),
      deliver: async (tokens) => {
        deliveries.push(tokens);
      },
    });
    await push.send({ title: "Done", body: "Done" });
    expect(deliveries).toEqual([["phone"]]);
    expect(JSON.parse(readFileSync(filePath, "utf8")).retentionMs).toBe(180 * 24 * 60 * 60 * 1000);
  });

  test("smart excludes only a destination token without removing its registration", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-notifications-"));
    homes.push(home);
    const deliveries: string[][] = [];
    const push = createPushNotifications({
      logger: createLogger(),
      filePath: path.join(home, "tokens.json"),
      deliver: async (tokens) => {
        deliveries.push(tokens);
      },
    });
    push.renew("viewing");
    push.renew("background");
    await push.send({ title: "Done", body: "Done", excludedTokens: ["viewing"] });
    await push.send({ title: "Done", body: "Done" });
    expect(deliveries).toEqual([["background"], ["viewing", "background"]]);
  });

  test("online revocation stops notifications immediately", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-notifications-"));
    homes.push(home);
    const deliveries: string[][] = [];
    const pushNotifications = createPushNotifications({
      logger: createLogger(),
      filePath: path.join(home, "push-tokens.json"),
      now: () => Date.parse("2026-08-10T00:00:00.000Z"),
      deliver: async (tokens) => deliveries.push(tokens),
    });

    pushNotifications.renew("ExponentPushToken[online-device]");
    pushNotifications.revoke("ExponentPushToken[online-device]");
    await pushNotifications.send({ title: "Agent finished", body: "Done" });

    expect(deliveries).toEqual([]);
  });
});
