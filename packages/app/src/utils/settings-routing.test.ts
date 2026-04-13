import { describe, expect, it } from "vitest";
import {
  LEGACY_SETTINGS_FALLBACK_ROUTE,
  resolveLegacySettingsTargetRoute,
} from "@/utils/settings-routing";

describe("settings routing", () => {
  it("routes to the active host settings when a server id exists", () => {
    expect(resolveLegacySettingsTargetRoute("server-1")).toBe("/h/server-1/settings");
  });

  it("trims the incoming server id before building the route", () => {
    expect(resolveLegacySettingsTargetRoute("  server-1  ")).toBe("/h/server-1/settings");
  });

  it("falls back to welcome when the server id is missing", () => {
    expect(resolveLegacySettingsTargetRoute(undefined)).toBe(LEGACY_SETTINGS_FALLBACK_ROUTE);
    expect(resolveLegacySettingsTargetRoute(null)).toBe(LEGACY_SETTINGS_FALLBACK_ROUTE);
    expect(resolveLegacySettingsTargetRoute("   ")).toBe(LEGACY_SETTINGS_FALLBACK_ROUTE);
  });
});

