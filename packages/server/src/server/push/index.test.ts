import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import { openDatabase } from "../db/open.js";
import { createPushNotifications } from "./index.js";
import { PushTokenStore } from "./token-store.js";

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
  const databases: DatabaseSync[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an offline device stops receiving notifications after 48 hours", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-notifications-"));
    homes.push(home);
    const database = openDatabase(home);
    databases.push(database);
    let now = Date.parse("2026-08-10T00:00:00.000Z");
    const deliveries: string[][] = [];
    const store = new PushTokenStore({
      database,
      legacyFilePath: path.join(home, "push-tokens.json"),
      logger: createLogger(),
      now: () => now,
    });
    const pushNotifications = createPushNotifications({
      logger: createLogger(),
      store,
      deliver: async (tokens) => deliveries.push(tokens),
    });

    pushNotifications.renew("ExponentPushToken[offline-device]");
    now += 48 * 60 * 60 * 1000;
    await pushNotifications.send({ title: "Agent finished", body: "Done" });

    expect(deliveries).toEqual([]);
    expect(database.prepare("SELECT count(*) AS count FROM push_tokens").get()).toMatchObject({
      count: 0,
    });
  });

  test("online revocation stops notifications immediately", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-notifications-"));
    homes.push(home);
    const database = openDatabase(home);
    databases.push(database);
    const deliveries: string[][] = [];
    const store = new PushTokenStore({
      database,
      legacyFilePath: path.join(home, "push-tokens.json"),
      logger: createLogger(),
      now: () => Date.parse("2026-08-10T00:00:00.000Z"),
    });
    const pushNotifications = createPushNotifications({
      logger: createLogger(),
      store,
      deliver: async (tokens) => deliveries.push(tokens),
    });

    pushNotifications.renew("ExponentPushToken[online-device]");
    pushNotifications.revoke("ExponentPushToken[online-device]");
    await pushNotifications.send({ title: "Agent finished", body: "Done" });

    expect(deliveries).toEqual([]);
  });
});
