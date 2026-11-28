import { describe, expect, it } from "vitest";
import {
  MAX_PLUGIN_NOTIFICATION_BODY_CHARS,
  MAX_PLUGIN_NOTIFICATION_DATA_BYTES,
  MAX_PLUGIN_NOTIFICATION_KEY_CHARS,
  MAX_PLUGIN_NOTIFICATION_OPEN_BYTES,
  MAX_PLUGIN_NOTIFICATION_OPEN_ID_CHARS,
  MAX_PLUGIN_NOTIFICATION_TITLE_CHARS,
  PLUGIN_NOTIFICATION_BURST_CAPACITY,
  PLUGIN_NOTIFICATION_DEDUP_WINDOW_MS,
  PLUGIN_NOTIFICATION_REFILL_INTERVAL_MS,
  PluginNotificationDispatcher,
  type ValidatedPluginNotification,
} from "./notifications.js";

function createTestDispatcher(initialNowMs = 1_000_000) {
  let nowMs = initialNowMs;
  let nextId = 0;
  const delivered: ValidatedPluginNotification[] = [];
  const dispatcher = new PluginNotificationDispatcher({
    now: () => nowMs,
    createId: () => `notif-${++nextId}`,
    deliver: (notification) => {
      delivered.push(notification);
    },
  });
  return {
    dispatcher,
    delivered,
    advanceTime: (deltaMs: number) => {
      nowMs += deltaMs;
    },
  };
}

describe("PluginNotificationDispatcher", () => {
  it("validates title, body, key, open target, and 1024-byte JSON data limit", async () => {
    const { dispatcher, delivered } = createTestDispatcher();

    await expect(dispatcher.dispatch("plugin-a", { title: "   ", body: "valid" })).rejects.toThrow(
      "Plugin notification title is required",
    );

    await expect(
      dispatcher.dispatch("plugin-a", {
        title: "valid",
        body: "valid",
        key: "k".repeat(MAX_PLUGIN_NOTIFICATION_KEY_CHARS + 1),
      }),
    ).rejects.toThrow(`must be 1 to ${MAX_PLUGIN_NOTIFICATION_KEY_CHARS} characters`);

    await expect(
      dispatcher.dispatch("plugin-a", {
        title: "valid",
        body: "valid",
        open: { type: "agent", agentId: "   " },
      }),
    ).rejects.toThrow(
      `open.agentId must be 1 to ${MAX_PLUGIN_NOTIFICATION_OPEN_ID_CHARS} characters`,
    );

    await expect(
      dispatcher.dispatch("plugin-a", {
        title: "valid",
        body: "valid",
        open: { type: "agent", agentId: "a".repeat(MAX_PLUGIN_NOTIFICATION_OPEN_ID_CHARS + 1) },
      }),
    ).rejects.toThrow(
      `open.agentId must be 1 to ${MAX_PLUGIN_NOTIFICATION_OPEN_ID_CHARS} characters`,
    );

    await expect(
      dispatcher.dispatch("plugin-a", {
        title: "valid",
        body: "valid",
        open: {
          type: "screen",
          screenId: "main",
          params: { log: "z".repeat(MAX_PLUGIN_NOTIFICATION_OPEN_BYTES) },
        },
      }),
    ).rejects.toThrow(`open must not exceed ${MAX_PLUGIN_NOTIFICATION_OPEN_BYTES} UTF-8 bytes`);

    await expect(
      dispatcher.dispatch("plugin-a", {
        title: "valid",
        body: "valid",
        open: { type: "screen", screenId: "main", params: { bad: 123 } },
      }),
    ).rejects.toThrow("open.params must be an object of strings");

    const oversizedData = {
      blob: "a".repeat(MAX_PLUGIN_NOTIFICATION_DATA_BYTES),
    };
    await expect(
      dispatcher.dispatch("plugin-a", {
        title: "valid",
        body: "valid",
        data: oversizedData,
      }),
    ).rejects.toThrow(`must not exceed ${MAX_PLUGIN_NOTIFICATION_DATA_BYTES} UTF-8 bytes`);

    // Multibyte UTF-8 characters count by UTF-8 byte length, not JS string length
    const multibyteOversized = {
      emoji: "🚀".repeat(260), // 260 * 4 = 1040 UTF-8 bytes (> 1024)
    };
    await expect(
      dispatcher.dispatch("plugin-a", {
        title: "valid",
        body: "valid",
        data: multibyteOversized,
      }),
    ).rejects.toThrow(`must not exceed ${MAX_PLUGIN_NOTIFICATION_DATA_BYTES} UTF-8 bytes`);

    expect(delivered).toEqual([]);

    const validResult = await dispatcher.dispatch("plugin-a", {
      title: "  Build finished  ",
      body: "  All checks passed  ",
      key: "  build:1  ",
      open: { type: "screen", screenId: "  report  ", params: { buildId: "1" } },
      data: { buildId: 1, ok: true },
    });
    expect(validResult).toEqual({ status: "sent", notificationId: "notif-1" });
    expect(delivered).toEqual([
      {
        pluginId: "plugin-a",
        notificationId: "notif-1",
        title: "Build finished",
        body: "All checks passed",
        open: { type: "screen", screenId: "report", params: { buildId: "1" } },
        data: { buildId: 1, ok: true },
      },
    ]);

    const longResult = await dispatcher.dispatch("plugin-a", {
      title: "T".repeat(MAX_PLUGIN_NOTIFICATION_TITLE_CHARS + 50),
      body: "Error stack line: ".repeat(120),
    });
    expect(longResult).toEqual({ status: "sent", notificationId: "notif-2" });
    expect(delivered[1]?.title.length).toBe(MAX_PLUGIN_NOTIFICATION_TITLE_CHARS);
    expect(delivered[1]?.title.endsWith("...")).toBe(true);
    expect(delivered[1]?.body.length).toBeLessThanOrEqual(MAX_PLUGIN_NOTIFICATION_BODY_CHARS);
    expect(delivered[1]?.body.endsWith("...")).toBe(true);
  });

  it("deduplicates identical (pluginId, key) within 60s and allows different plugins or expired keys", async () => {
    const { dispatcher, delivered, advanceTime } = createTestDispatcher();

    await expect(
      dispatcher.dispatch("plugin-a", { title: "First", body: "1", key: "job-1" }),
    ).resolves.toEqual({ status: "sent", notificationId: "notif-1" });

    // Same plugin + key within 60s -> deduplicated
    advanceTime(PLUGIN_NOTIFICATION_DEDUP_WINDOW_MS - 1);
    await expect(
      dispatcher.dispatch("plugin-a", { title: "Duplicate", body: "2", key: "job-1" }),
    ).resolves.toEqual({ status: "deduplicated" });

    // Different plugin with same key -> sent
    await expect(
      dispatcher.dispatch("plugin-b", { title: "Other plugin", body: "1", key: "job-1" }),
    ).resolves.toEqual({ status: "sent", notificationId: "notif-2" });

    // After 60s window expires -> sent again
    advanceTime(1);
    await expect(
      dispatcher.dispatch("plugin-a", { title: "After expiry", body: "3", key: "job-1" }),
    ).resolves.toEqual({ status: "sent", notificationId: "notif-3" });

    // Clearing plugin state resets dedup immediately
    await expect(
      dispatcher.dispatch("plugin-a", { title: "Again", body: "4", key: "job-1" }),
    ).resolves.toEqual({ status: "deduplicated" });
    dispatcher.clearPlugin("plugin-a");
    await expect(
      dispatcher.dispatch("plugin-a", { title: "After clear", body: "5", key: "job-1" }),
    ).resolves.toEqual({ status: "sent", notificationId: "notif-4" });

    expect(delivered.map((item) => item.notificationId)).toEqual([
      "notif-1",
      "notif-2",
      "notif-3",
      "notif-4",
    ]);
  });

  it("enforces per-plugin token-bucket rate limit (burst 10, refill 1 per 6s)", async () => {
    const { dispatcher, delivered, advanceTime } = createTestDispatcher();

    for (let i = 1; i <= PLUGIN_NOTIFICATION_BURST_CAPACITY; i++) {
      await expect(
        dispatcher.dispatch("plugin-a", { title: `Msg ${i}`, body: "ok" }),
      ).resolves.toEqual({ status: "sent", notificationId: `notif-${i}` });
    }

    // 11th in burst -> rate_limited (and does not record dedup key)
    await expect(
      dispatcher.dispatch("plugin-a", {
        title: "Overflow",
        body: "blocked",
        key: "overflow-key",
      }),
    ).resolves.toEqual({ status: "rate_limited" });

    // Another plugin has its own bucket
    await expect(dispatcher.dispatch("plugin-b", { title: "Other", body: "ok" })).resolves.toEqual({
      status: "sent",
      notificationId: `notif-${PLUGIN_NOTIFICATION_BURST_CAPACITY + 1}`,
    });

    // Advance 6s -> 1 token refilled for plugin-a, and "overflow-key" was not burned
    advanceTime(PLUGIN_NOTIFICATION_REFILL_INTERVAL_MS);
    await expect(
      dispatcher.dispatch("plugin-a", {
        title: "Refilled",
        body: "allowed",
        key: "overflow-key",
      }),
    ).resolves.toEqual({
      status: "sent",
      notificationId: `notif-${PLUGIN_NOTIFICATION_BURST_CAPACITY + 2}`,
    });

    expect(delivered).toHaveLength(PLUGIN_NOTIFICATION_BURST_CAPACITY + 2);
  });
});
