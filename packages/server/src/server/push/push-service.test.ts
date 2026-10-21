import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPushNotifications } from "./index.js";
import { PushService } from "./push-service.js";
import {
  createNotificationHttpFake,
  createNotificationTestLogger,
} from "../notifications/test-utils.js";

describe("Expo provider", () => {
  const homes: string[] = [];
  function filePath() {
    const home = mkdtempSync(join(tmpdir(), "paseo-expo-"));
    homes.push(home);
    return join(home, "queue.json");
  }
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });
  const payload = {
    title: "Agent finished",
    body: "Done",
    data: {
      serverId: "server",
      agentId: "agent",
      workspaceId: "workspace",
      notificationId: "event",
    },
  };

  it("persists accepted tickets and checks receipts after restart", async () => {
    const fake = createNotificationHttpFake([
      { body: { data: [{ status: "ok", id: "ticket" }] } },
      { body: { data: { ticket: { status: "ok" } } } },
    ]);
    let now = 0;
    const { logger, records } = createNotificationTestLogger();
    const options = {
      filePath: filePath(),
      logger,
      revokeToken: () => {},
      isRegistered: () => true,
      http: fake.request,
      now: () => now,
      automatic: false,
    };
    const service = new PushService(options);
    await service.sendPush(["private-device-token"], payload);
    expect(fake.requests).toHaveLength(1);
    expect(JSON.parse(fake.requests[0].init.body as string)[0]).toMatchObject({
      priority: "high",
      data: payload.data,
    });
    await service.close();
    const restarted = new PushService(options);
    now = 15 * 60 * 1000;
    await restarted.drain();
    expect(fake.requests[1].url).toContain("getReceipts");
    expect(records.join("\n")).toContain("accepted");
    expect(records.join("\n")).toContain("delivered_to_push_provider");
    expect(records.join("\n")).not.toContain("private-device-token");
    await restarted.close();
  });
  it.each(["DeviceNotRegistered", "InvalidCredentials"])(
    "handles ticket error %s without exposing tokens",
    async (category) => {
      const fake = createNotificationHttpFake([
        {
          body: {
            data: [{ status: "error", message: "SECRET token", details: { error: category } }],
          },
        },
      ]);
      const revoked: string[] = [];
      const { logger, records } = createNotificationTestLogger();
      const service = new PushService({
        filePath: filePath(),
        logger,
        http: fake.request,
        automatic: false,
        revokeToken: (token) => {
          revoked.push(token);
        },
        isRegistered: () => true,
      });
      await service.sendPush(["SECRET"], payload);
      expect(revoked).toEqual(category === "DeviceNotRegistered" ? ["SECRET"] : []);
      expect(records.join("\n")).not.toContain("SECRET");
      await service.close();
    },
  );
  it("revokes DeviceNotRegistered from a receipt", async () => {
    const fake = createNotificationHttpFake([
      { body: { data: [{ status: "ok", id: "ticket" }] } },
      {
        body: { data: { ticket: { status: "error", details: { error: "DeviceNotRegistered" } } } },
      },
    ]);
    let now = 0;
    const revoked: string[] = [];
    const service = new PushService({
      filePath: filePath(),
      logger: createNotificationTestLogger().logger,
      http: fake.request,
      automatic: false,
      now: () => now,
      isRegistered: () => true,
      revokeToken: (token) => {
        revoked.push(token);
      },
    });
    await service.sendPush(["token"], payload);
    now = 900_000;
    await service.drain();
    expect(revoked).toEqual(["token"]);
    await service.close();
  });
  it.each([429, 503, "network"])("retries temporary %s failures", async (status) => {
    const fake = createNotificationHttpFake([
      status === "network"
        ? new Error("network private-token")
        : { status, headers: { "Retry-After": "3" } },
      { body: { data: [{ status: "ok", id: "ticket" }] } },
    ]);
    let now = 0;
    const service = new PushService({
      filePath: filePath(),
      logger: createNotificationTestLogger().logger,
      http: fake.request,
      automatic: false,
      now: () => now,
      random: () => 0,
      isRegistered: () => true,
      revokeToken: () => {},
    });
    await service.sendPush(["token"], payload);
    expect(fake.requests).toHaveLength(1);
    now = 3000;
    await service.drain();
    expect(fake.requests).toHaveLength(2);
    await service.close();
  });
  it("leaves a saved retry dormant when Expo is disabled on restart", async () => {
    const file = filePath();
    const fake = createNotificationHttpFake([{ status: 503 }]);
    const options = {
      filePath: file,
      logger: createNotificationTestLogger().logger,
      http: fake.request,
      now: () => 0,
      automatic: false,
    };
    const first = createPushNotifications(options);
    first.renew("token");
    await first.send(payload);
    await first.close?.();
    const disabled = createPushNotifications({ ...options, enabled: false, now: () => 10_000 });
    await disabled.send(payload);
    expect(fake.requests).toHaveLength(1);
    await disabled.close?.();
  });

  it("does not deliver a pending send after explicit device revocation", async () => {
    let now = 0;
    let registered = true;
    const fake = createNotificationHttpFake([{ status: 503 }]);
    const service = new PushService({
      filePath: filePath(),
      logger: createNotificationTestLogger().logger,
      http: fake.request,
      now: () => now,
      automatic: false,
      isRegistered: () => registered,
      revokeToken: () => {},
    });
    await service.sendPush(["token"], payload);
    registered = false;
    now = 10_000;
    await service.drain();
    expect(fake.requests).toHaveLength(1);
    await service.close();
  });

  it("does not retry HTTP 400 or resend a revoked device", async () => {
    const fake = createNotificationHttpFake([{ status: 400 }]);
    let now = 0;
    const service = new PushService({
      filePath: filePath(),
      logger: createNotificationTestLogger().logger,
      http: fake.request,
      automatic: false,
      now: () => now,
      isRegistered: () => true,
      revokeToken: () => {},
    });
    await service.sendPush(["token"], payload);
    now = 100_000;
    await service.drain();
    expect(fake.requests).toHaveLength(1);
    await service.close();
  });
  it("sends distinct devices and deduplicates repeated event IDs", async () => {
    const fake = createNotificationHttpFake([
      { body: { data: [{ status: "ok", id: "a" }] } },
      { body: { data: [{ status: "ok", id: "b" }] } },
    ]);
    let now = 0;
    const service = new PushService({
      filePath: filePath(),
      logger: createNotificationTestLogger().logger,
      http: fake.request,
      automatic: false,
      now: () => now,
      isRegistered: () => true,
      revokeToken: () => {},
    });
    await service.sendPush(["phone-a", "phone-b"], payload);
    now = 200;
    await service.drain();
    await service.sendPush(["phone-a", "phone-b"], payload);
    expect(fake.requests.map((request) => JSON.parse(request.init.body as string)[0].to)).toEqual([
      "phone-a",
      "phone-b",
    ]);
    await service.close();
  });
});
