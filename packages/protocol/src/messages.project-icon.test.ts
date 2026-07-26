import { describe, expect, test } from "vitest";
import {
  parseServerInfoStatusPayload,
  ProjectIconUpdateRequestSchema,
  ProjectIconUpdateResponseSchema,
} from "./messages.js";

describe("project icon messages", () => {
  test("accepts the existing PNG update shape", () => {
    expect(
      ProjectIconUpdateRequestSchema.parse({
        type: "project.icon.update.request",
        cwd: "/repo",
        icon: { data: "base64", mimeType: "image/png" },
        requestId: "req-image",
      }).icon,
    ).toEqual({ data: "base64", mimeType: "image/png" });
  });

  test("accepts an emoji update", () => {
    expect(
      ProjectIconUpdateRequestSchema.parse({
        type: "project.icon.update.request",
        cwd: "/repo",
        icon: { emoji: "\u{1F4B2}", mimeType: "text/plain" },
        requestId: "req-emoji",
      }).icon,
    ).toEqual({ emoji: "\u{1F4B2}", mimeType: "text/plain" });
  });

  test("keeps image response fields while adding optional emoji metadata", () => {
    const parsed = ProjectIconUpdateResponseSchema.parse({
      type: "project.icon.update.response",
      payload: {
        cwd: "/repo",
        icon: {
          data: "base64-svg",
          mimeType: "image/svg+xml",
          source: "custom",
          emoji: "\u{1F4B2}",
        },
        error: null,
        requestId: "req-emoji",
      },
    });

    expect(parsed.payload.icon?.emoji).toBe("\u{1F4B2}");
  });

  test("parses the emoji feature gate", () => {
    const parsed = parseServerInfoStatusPayload({
      status: "server_info",
      serverId: "srv-test",
      features: { projectEmojiIcon: true },
    });

    expect(parsed?.features?.projectEmojiIcon).toBe(true);
  });
});
