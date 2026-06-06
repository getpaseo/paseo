import { afterEach, describe, expect, it } from "vitest";
import {
  buildSettingsEntryRoute,
  consumeSettingsEntryReturnPath,
  isSettingsPathname,
  peekSettingsEntryContext,
  prepareSettingsEntryNavigation,
} from "./settings-entry-context";

describe("settings-entry-context", () => {
  afterEach(() => {
    prepareSettingsEntryNavigation("/welcome");
  });

  it("builds a host-scoped settings route from host routes", () => {
    expect(buildSettingsEntryRoute("/h/srv-1/workspace/repo")).toBe(
      "/settings/hosts/srv-1/connections",
    );
    expect(buildSettingsEntryRoute("/h/srv-1/open-project")).toBe(
      "/settings/hosts/srv-1/connections",
    );
  });

  it("falls back to the settings root when there is no host route", () => {
    expect(buildSettingsEntryRoute("/")).toBe("/settings");
    expect(buildSettingsEntryRoute("/welcome")).toBe("/settings");
  });

  it("recognizes both current and legacy settings pathnames", () => {
    expect(isSettingsPathname("/settings")).toBe(true);
    expect(isSettingsPathname("/settings/hosts/srv-1/connections")).toBe(true);
    expect(isSettingsPathname("/h/srv-1/settings")).toBe(true);
    expect(isSettingsPathname("/h/srv-1/open-project")).toBe(false);
  });

  it("prepares navigation and consumes the return path once", () => {
    expect(prepareSettingsEntryNavigation("/h/srv-1/open-project")).toBe(
      "/settings/hosts/srv-1/connections",
    );
    expect(peekSettingsEntryContext()?.returnPathname).toBe("/h/srv-1/open-project");
    expect(consumeSettingsEntryReturnPath()).toBe("/h/srv-1/open-project");
    expect(consumeSettingsEntryReturnPath()).toBeNull();
  });

  it("records host and workspace metadata for the current settings entry", () => {
    prepareSettingsEntryNavigation("/h/srv-1/workspace/repo");
    expect(peekSettingsEntryContext()).toEqual({
      returnPathname: "/h/srv-1/workspace/repo",
      serverId: "srv-1",
      workspaceId: "repo",
    });
  });

  it("keeps the current entry context when settings is opened again from inside settings", () => {
    expect(prepareSettingsEntryNavigation("/h/srv-1/open-project")).toBe(
      "/settings/hosts/srv-1/connections",
    );
    expect(prepareSettingsEntryNavigation("/settings/general")).toBe("/settings");
    expect(consumeSettingsEntryReturnPath()).toBe("/h/srv-1/open-project");
  });

  it("clears stale entry context when settings is opened from a non-host route", () => {
    prepareSettingsEntryNavigation("/h/srv-1/open-project");
    expect(prepareSettingsEntryNavigation("/welcome")).toBe("/settings");
    expect(peekSettingsEntryContext()).toBeNull();
  });

  it("does not record settings routes as return targets", () => {
    expect(prepareSettingsEntryNavigation("/settings/general")).toBe("/settings");
    expect(consumeSettingsEntryReturnPath()).toBeNull();
  });
});
