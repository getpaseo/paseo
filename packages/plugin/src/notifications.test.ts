import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineRpc } from "./rpc.js";
import {
  MIN_PLUGIN_NOTIFICATION_INTERVAL_MS,
  PluginNotificationPollResultSchema,
  readPluginNotificationSource,
  resolvePluginNotificationInterval,
} from "./notifications.js";

const poll = defineRpc({
  name: "reviews.notifications",
  input: z.object({}),
  output: PluginNotificationPollResultSchema,
});

describe("plugin notification sources", () => {
  it("reads and validates notification events through the declared RPC", async () => {
    const invoke = vi.fn(async () => ({
      notifications: [
        {
          id: "review-42",
          title: "Review requested",
          body: "feat: decouple notifications",
          surface: "reviews",
        },
      ],
    }));

    await expect(
      readPluginNotificationSource({ id: "review-requests", rpc: poll }, invoke),
    ).resolves.toEqual({
      notifications: [
        {
          id: "review-42",
          title: "Review requested",
          body: "feat: decouple notifications",
          surface: "reviews",
        },
      ],
    });
    expect(invoke).toHaveBeenCalledWith("reviews.notifications", {});
  });

  it("rejects duplicate event ids in one poll", () => {
    expect(() =>
      PluginNotificationPollResultSchema.parse({
        notifications: [
          { id: "review-42", title: "First" },
          { id: "review-42", title: "Second" },
        ],
      }),
    ).toThrow("Duplicate notification id: review-42");
  });

  it("uses a default cadence and floors aggressive polling", () => {
    expect(resolvePluginNotificationInterval()).toBe(60_000);
    expect(resolvePluginNotificationInterval(1_000)).toBe(MIN_PLUGIN_NOTIFICATION_INTERVAL_MS);
    expect(() => resolvePluginNotificationInterval(Number.NaN)).toThrow("positive finite number");
  });
});
