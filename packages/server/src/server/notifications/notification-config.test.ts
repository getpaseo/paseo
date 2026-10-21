import { describe, expect, it } from "vitest";
import { resolveNotificationConfig } from "./notification-config.js";
import { PersistedConfigSchema } from "../persisted-config.js";
import { resolveConfigFromPersisted } from "../config.js";
import { configurationEnvironment, daemonLaunchEnvironment } from "../config-environment.js";

describe("notification configuration", () => {
  const env = {
    PASEO_NOTIFICATION_PROVIDER: "ntfy",
    PASEO_NTFY_URL: "https://ntfy.example.com",
    PASEO_NTFY_TOPIC: "agents",
    PASEO_NTFY_TOKEN: "private-token",
  };
  it("keeps legacy Expo routing as the default", () => {
    expect(resolveNotificationConfig({})).toMatchObject({
      mode: "legacy",
      provider: "expo",
      enabled: true,
      tokenRetentionDays: 180,
      includePreviews: false,
    });
  });
  it("resolves persisted settings and environment overrides through daemon config", () => {
    const persisted = PersistedConfigSchema.parse({
      daemon: { notifications: { mode: "smart", onFinish: false } },
    });
    expect(
      resolveConfigFromPersisted("/tmp/notification-config", persisted, {
        env: { ...env, PASEO_NOTIFICATION_MODE: "always_push", PASEO_NOTIFY_ON_ERROR: "true" },
      }).notifications,
    ).toMatchObject({
      mode: "always_push",
      provider: "ntfy",
      onError: true,
      onFinish: false,
    });
    expect(configurationEnvironment(env).PASEO_NTFY_TOKEN).toBe("private-token");
    expect(
      daemonLaunchEnvironment({ env, home: "/tmp/home", mode: "managed" }).PASEO_NTFY_TOKEN,
    ).toBeUndefined();
  });
  it.each(["PASEO_NTFY_URL", "PASEO_NTFY_TOKEN", "PASEO_NTFY_TOPIC"])(
    "rejects a missing %s",
    (key) => {
      expect(() => resolveNotificationConfig({ ...env, [key]: undefined })).toThrow(
        "ntfy notifications require",
      );
    },
  );
  it.each([
    "http://ntfy.example.com",
    "https://user:password@ntfy.example.com",
    "https://ntfy.example.com?token=secret",
    "ftp://ntfy.example.com",
  ])("rejects unsafe URL %s without exposing credentials", (url) => {
    expect(() => resolveNotificationConfig({ ...env, PASEO_NTFY_URL: url })).toThrow(
      "ntfy requires HTTPS",
    );
  });
  it("allows explicitly trusted HTTP and validates priorities", () => {
    expect(
      resolveNotificationConfig({
        ...env,
        PASEO_NTFY_URL: "http://localhost:8080",
        PASEO_NTFY_ALLOW_HTTP: "true",
      }).ntfy.allowHttp,
    ).toBe(true);
    expect(() =>
      resolveNotificationConfig({ ...env, PASEO_NTFY_PRIORITY_ERROR: "invalid" }),
    ).toThrow("Invalid notification configuration");
  });
  it("rejects invalid boolean values and header injection", () => {
    expect(() => resolveNotificationConfig({ PASEO_NOTIFICATIONS_ENABLED: "tru" })).toThrow(
      "Invalid boolean",
    );
    expect(() =>
      resolveNotificationConfig({ ...env, PASEO_NTFY_TOKEN: "secret\r\nHeader: value" }),
    ).toThrow("Invalid notification configuration");
  });
});
