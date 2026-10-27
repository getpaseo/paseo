import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import { createPushNotifications } from "./index.js";
import { PushService } from "./push-service.js";

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

  test("sends production and development app tokens in separate Expo requests", async () => {
    const requests: unknown[] = [];
    const request: typeof fetch = async (_url, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
      const messages: unknown = JSON.parse(init.body);
      requests.push(messages);
      if (!Array.isArray(messages) || messages.length !== 1) {
        return Response.json(
          { errors: [{ code: "PUSH_TOO_MANY_EXPERIENCE_IDS" }] },
          { status: 400 },
        );
      }
      return Response.json({ data: [{ status: "ok", id: "accepted" }] });
    };
    const revoked: string[] = [];
    const service = new PushService(createLogger(), (token) => revoked.push(token), request);
    const payload = { title: "Agent finished", body: "Done", data: { agentId: "agent-1" } };

    await service.sendPush(
      ["ExponentPushToken[production]", "ExponentPushToken[development]"],
      payload,
    );

    expect(requests).toEqual([
      [{ to: "ExponentPushToken[production]", ...payload, sound: "default" }],
      [{ to: "ExponentPushToken[development]", ...payload, sound: "default" }],
    ]);
    expect(revoked).toEqual([]);
  });

  test("an invalid device does not prevent delivery to the next device", async () => {
    let requestCount = 0;
    const request: typeof fetch = async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return Response.json({
          data: [{ status: "error", details: { error: "DeviceNotRegistered" } }],
        });
      }
      return Response.json({ data: [{ status: "ok", id: "accepted" }] });
    };
    const revoked: string[] = [];
    const service = new PushService(createLogger(), (token) => revoked.push(token), request);

    await service.sendPush(["ExponentPushToken[uninstalled]", "ExponentPushToken[active]"], {
      title: "Agent finished",
      body: "Done",
    });

    expect(requestCount).toBe(2);
    expect(revoked).toEqual(["ExponentPushToken[uninstalled]"]);
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
});
