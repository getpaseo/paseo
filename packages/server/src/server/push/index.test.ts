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

interface HeldExpoFetches {
  request: typeof fetch;
  /** Resolves with the parsed bodies once `count` requests are in flight. */
  requestsOnceStarted: () => Promise<unknown[]>;
  releaseOk: () => void;
}

function holdExpoFetches(count: number): HeldExpoFetches {
  const requests: unknown[] = [];
  const pending: Array<(response: Response) => void> = [];
  let markStarted: () => void = () => {
    throw new Error("Push fetches started before the gate was installed");
  };
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const request: typeof fetch = (_url, init) => {
    if (typeof init?.body !== "string") {
      return Promise.reject(new Error("Expected a JSON request body"));
    }
    const messages: unknown = JSON.parse(init.body);
    requests.push(messages);
    const singleToken = Array.isArray(messages) && messages.length === 1;
    if (!singleToken || requests.length >= count) {
      markStarted();
    }
    return new Promise<Response>((resolve) => {
      pending.push(resolve);
    });
  };
  return {
    request,
    async requestsOnceStarted() {
      await started;
      return requests;
    },
    releaseOk() {
      for (const resolve of pending.splice(0)) {
        resolve(Response.json({ data: [{ status: "ok", id: "accepted" }] }));
      }
    },
  };
}

describe("push notifications", () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("sends production and development app tokens in separate Expo requests", async () => {
    const fetches = holdExpoFetches(2);
    const revoked: string[] = [];
    const service = new PushService({
      logger: createLogger(),
      revokeToken: (token) => revoked.push(token),
      request: fetches.request,
    });
    const payload = { title: "Agent finished", body: "Done", data: { agentId: "agent-1" } };

    const send = service.sendPush(
      ["ExponentPushToken[production]", "ExponentPushToken[development]"],
      payload,
    );

    try {
      expect(await fetches.requestsOnceStarted()).toEqual([
        [{ to: "ExponentPushToken[production]", ...payload, sound: "default" }],
        [{ to: "ExponentPushToken[development]", ...payload, sound: "default" }],
      ]);
    } finally {
      fetches.releaseOk();
    }
    await send;
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
    const service = new PushService({
      logger: createLogger(),
      revokeToken: (token) => revoked.push(token),
      request,
    });

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
