import { describe, expect, test } from "vitest";
import {
  assertSafeWebPushEndpoint,
  createEndpointLogContext,
  isPublicIpAddress,
} from "./endpoint-security.js";

describe("Web Push endpoint security", () => {
  test("accepts global HTTPS endpoints", async () => {
    await expect(
      assertSafeWebPushEndpoint("https://push.example.test/subscription/abc", {
        resolveHost: async () => ["8.8.8.8"],
      }),
    ).resolves.toEqual(new URL("https://push.example.test/subscription/abc"));
  });

  test("rejects non-HTTPS endpoints", async () => {
    await expect(
      assertSafeWebPushEndpoint("http://push.example.test/subscription/abc", {
        resolveHost: async () => ["8.8.8.8"],
      }),
    ).rejects.toThrow("Web Push endpoint must use HTTPS");
  });

  test("rejects local and private IP resolutions", async () => {
    const blocked = [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.0.1",
      "::1",
      "fc00::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:7f00:1",
    ];
    for (const address of blocked) {
      await expect(
        assertSafeWebPushEndpoint("https://push.example.test/subscription/abc", {
          resolveHost: async () => [address],
        }),
      ).rejects.toThrow("Web Push endpoint resolves to a non-public address");
    }
  });

  test("classifies public IP addresses", () => {
    expect(isPublicIpAddress("8.8.8.8")).toBe(true);
    expect(isPublicIpAddress("2001:4860:4860::8888")).toBe(true);
    expect(isPublicIpAddress("169.254.1.1")).toBe(false);
    expect(isPublicIpAddress("224.0.0.1")).toBe(false);
    expect(isPublicIpAddress("0.0.0.0")).toBe(false);
  });

  test("redacts endpoint path and query from log context", () => {
    const context = createEndpointLogContext(
      "https://push.example.test/subscription/secret?token=value",
    );

    expect(context).toEqual({
      endpointHost: "push.example.test",
      endpointHash: expect.stringMatching(/^[a-f0-9]{12}$/),
    });
  });
});
