import { describe, expect, test } from "vitest";
import { OpenCodeLocationReadyTimeoutError, waitForLocationReady } from "./readiness.js";

describe("OpenCode v2 location readiness", () => {
  test("fails location readiness when the plugin inventory never populates", async () => {
    await expect(
      waitForLocationReady({
        client: { plugin: { list: async () => ({ location: { directory: "/tmp" }, data: [] }) } },
        location: { directory: "/tmp" },
        timeoutMs: 25,
      }),
    ).rejects.toBeInstanceOf(OpenCodeLocationReadyTimeoutError);
  });

  test("bounds location readiness even when the inventory request never settles", async () => {
    await expect(
      waitForLocationReady({
        client: { plugin: { list: () => new Promise(() => undefined) } },
        location: { directory: "/tmp" },
        timeoutMs: 25,
      }),
    ).rejects.toBeInstanceOf(OpenCodeLocationReadyTimeoutError);
  });

  test("preserves inventory errors instead of reporting a readiness timeout", async () => {
    const error = new Error("inventory unavailable");
    await expect(
      waitForLocationReady({
        client: {
          plugin: {
            list: async () => {
              throw error;
            },
          },
        },
        location: { directory: "/tmp" },
      }),
    ).rejects.toBe(error);
  });
});
