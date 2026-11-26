import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import { afterEach, describe, expect, test } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
} from "@getpaseo/protocol/notification-preferences";

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

  test("an offline device stops receiving notifications after 48 hours", async () => {
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

    expect(deliveries).toEqual([]);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({ subscriptions: [] });
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

  test("tokens registered without preferences retain legacy push filtering while explicit defaults apply new defaults", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-notifications-"));
    homes.push(home);
    const deliveries: string[][] = [];
    const pushNotifications = createPushNotifications({
      logger: createLogger(),
      filePath: path.join(home, "push-tokens.json"),
      now: () => Date.parse("2026-08-10T00:00:00.000Z"),
      deliver: async (tokens) => deliveries.push(tokens),
    });

    pushNotifications.renew("ExponentPushToken[legacy-device]");
    pushNotifications.renew("ExponentPushToken[modern-device]", DEFAULT_NOTIFICATION_PREFERENCES);

    // Legacy tokens keep finished pushes and skip error pushes; modern defaults flip that.
    await pushNotifications.send(
      { title: "Agent finished", body: "Done" },
      { kind: "agent", reason: "finished" },
    );
    expect(deliveries).toEqual([["ExponentPushToken[legacy-device]"]]);

    await pushNotifications.send(
      { title: "Agent needs attention", body: "Encountered an error." },
      { kind: "agent", reason: "error" },
    );
    expect(deliveries).toEqual([
      ["ExponentPushToken[legacy-device]"],
      ["ExponentPushToken[modern-device]"],
    ]);
  });

  test("per-token filtering delivers to eligible tokens and skips ineligible ones in the same send call", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-notifications-"));
    homes.push(home);
    const deliveries: string[][] = [];
    const pushNotifications = createPushNotifications({
      logger: createLogger(),
      filePath: path.join(home, "push-tokens.json"),
      now: () => Date.parse("2026-08-10T00:00:00.000Z"),
      deliver: async (tokens) => deliveries.push(tokens),
    });

    const phoneAPrefs: NotificationPreferences = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      events: {
        ...DEFAULT_NOTIFICATION_PREFERENCES.events,
        agentFinished: true,
      },
      plugins: {
        enabled: true,
        muted: ["muted-on-a"],
      },
    };
    const phoneBPrefs: NotificationPreferences = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      events: {
        ...DEFAULT_NOTIFICATION_PREFERENCES.events,
        agentFinished: false,
      },
      plugins: {
        enabled: true,
        muted: [],
      },
    };
    const phoneCPrefs: NotificationPreferences = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      enabled: false,
      events: {
        agentPermission: true,
        agentError: true,
        agentFinished: true,
        terminalNeedsInput: true,
        terminalFinished: true,
      },
    };

    pushNotifications.renew("ExponentPushToken[phone-a]", phoneAPrefs);
    pushNotifications.renew("ExponentPushToken[phone-b]", phoneBPrefs);
    pushNotifications.renew("ExponentPushToken[phone-c]", phoneCPrefs);

    await pushNotifications.send(
      { title: "Agent finished", body: "Done" },
      { kind: "agent", reason: "finished" },
    );
    expect(deliveries).toEqual([["ExponentPushToken[phone-a]"]]);

    await pushNotifications.send(
      { title: "Plugin alert", body: "Check failed" },
      { kind: "plugin", pluginId: "muted-on-a" },
    );
    expect(deliveries).toEqual([["ExponentPushToken[phone-a]"], ["ExponentPushToken[phone-b]"]]);
  });
});
