import { describe, expect, it, vi } from "vitest";
import { defineRpc, PluginNotificationPollResultSchema } from "@getpaseo/plugin";
import { z } from "zod";
import {
  PluginNotificationReceiptStore,
  type PluginNotificationReceiptStorage,
} from "./notification-receipts";
import { createPluginNotifier, pollPluginNotificationSource } from "./notifications";

vi.mock("@/utils/os-notifications", () => ({ sendOsNotification: vi.fn() }));

class MemoryStorage implements PluginNotificationReceiptStorage {
  readonly values = new Map<string, string>();

  async getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const rpc = defineRpc({
  name: "reviews.notifications",
  input: z.object({}),
  output: PluginNotificationPollResultSchema,
});

describe("plugin notifications", () => {
  it("routes a validated notification through the host notification API", async () => {
    const sendOsNotification = vi.fn(async () => true);
    const notifier = createPluginNotifier(
      { serverId: "host-1", pluginId: "review", surfaceIds: ["inbox"] },
      { sendOsNotification },
    );

    await expect(
      notifier.notify({
        title: " Review requested ",
        body: " PR #42 ",
        surface: "inbox",
      }),
    ).resolves.toBe(true);
    expect(sendOsNotification).toHaveBeenCalledWith({
      title: "Review requested",
      body: "PR #42",
      data: {
        serverId: "host-1",
        pluginId: "review",
        pluginSurfaceId: "inbox",
      },
    });
  });

  it("rejects a click target that the plugin did not contribute", async () => {
    const notifier = createPluginNotifier(
      { serverId: "host-1", pluginId: "review", surfaceIds: ["inbox"] },
      { sendOsNotification: async () => true },
    );

    await expect(notifier.notify({ title: "Review", surface: "missing" })).rejects.toThrow(
      "Plugin surface is unavailable: missing",
    );
  });

  it("delivers each stable event once across updates and app restarts", async () => {
    const storage = new MemoryStorage();
    let receipts = new PluginNotificationReceiptStore(storage);
    const notify = vi.fn(async () => true);
    let response = {
      notifications: [{ id: "review-42", title: "Review requested" }],
    };
    const input = {
      source: { id: "review-requests", rpc },
      scope: { serverId: "host-1", pluginId: "review", sourceId: "review-requests" },
      invoke: vi.fn(async () => response),
      notifier: { notify },
      receipts,
      reportError: vi.fn(),
    };

    await expect(pollPluginNotificationSource(input)).resolves.toEqual({
      claimed: 1,
      delivered: 1,
    });

    response = {
      notifications: [{ id: "review-42", title: "Review updated" }],
    };
    await expect(pollPluginNotificationSource(input)).resolves.toEqual({
      claimed: 0,
      delivered: 0,
    });

    receipts = new PluginNotificationReceiptStore(storage);
    await expect(pollPluginNotificationSource({ ...input, receipts })).resolves.toEqual({
      claimed: 0,
      delivered: 0,
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("isolates event ids by host, plugin, and source", async () => {
    const receipts = new PluginNotificationReceiptStore(new MemoryStorage());
    const notifier = { notify: vi.fn(async () => true) };
    const invoke = vi.fn(async () => ({
      notifications: [{ id: "review-42", title: "Review requested" }],
    }));
    const base = {
      source: { id: "review-requests", rpc },
      invoke,
      notifier,
      receipts,
      reportError: vi.fn(),
    };

    await pollPluginNotificationSource({
      ...base,
      scope: { serverId: "host-1", pluginId: "review", sourceId: "review-requests" },
    });
    await pollPluginNotificationSource({
      ...base,
      scope: { serverId: "host-2", pluginId: "review", sourceId: "review-requests" },
    });

    expect(notifier.notify).toHaveBeenCalledTimes(2);
  });
});
