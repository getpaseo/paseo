import { describe, expect, it } from "vitest";
import { parseSettingsViewFromPathname } from "./settings-navigation";

describe("parseSettingsViewFromPathname", () => {
  it("returns null off the settings tree", () => {
    expect(parseSettingsViewFromPathname("/")).toBeNull();
    expect(parseSettingsViewFromPathname("/open-project")).toBeNull();
    expect(parseSettingsViewFromPathname("/h/srv_1/workspace/ws_1")).toBeNull();
    expect(parseSettingsViewFromPathname("/settingsish")).toBeNull();
  });

  it("reads the settings root", () => {
    expect(parseSettingsViewFromPathname("/settings")).toEqual({ kind: "root" });
    expect(parseSettingsViewFromPathname("/settings/")).toEqual({ kind: "root" });
  });

  it("reads an app section", () => {
    expect(parseSettingsViewFromPathname("/settings/appearance")).toEqual({
      kind: "section",
      section: "appearance",
    });
  });

  it("falls back to general for an unknown app section", () => {
    expect(parseSettingsViewFromPathname("/settings/nope")).toEqual({
      kind: "section",
      section: "general",
    });
  });

  it("reads a host section", () => {
    expect(parseSettingsViewFromPathname("/settings/hosts/srv_1/usage")).toEqual({
      kind: "host",
      serverId: "srv_1",
      section: "usage",
    });
  });

  it("normalizes legacy host section slugs", () => {
    expect(parseSettingsViewFromPathname("/settings/hosts/srv_1/daemon")).toEqual({
      kind: "host",
      serverId: "srv_1",
      section: "host",
    });
  });

  it("treats the host index like its connections redirect target", () => {
    expect(parseSettingsViewFromPathname("/settings/hosts/srv_1")).toEqual({
      kind: "host",
      serverId: "srv_1",
      section: "connections",
    });
  });

  it("reads the projects index as the projects host section", () => {
    expect(parseSettingsViewFromPathname("/settings/hosts/srv_1/projects")).toEqual({
      kind: "host",
      serverId: "srv_1",
      section: "projects",
    });
  });

  it("reads a project detail route", () => {
    expect(parseSettingsViewFromPathname("/settings/hosts/srv_1/projects/proj_1")).toEqual({
      kind: "project",
      serverId: "srv_1",
      projectId: "proj_1",
    });
  });

  it("reads a plugin screen route rather than the plugins host section", () => {
    expect(
      parseSettingsViewFromPathname("/settings/hosts/srv_1/plugins/my-plugin/my-screen"),
    ).toEqual({
      kind: "plugin",
      serverId: "srv_1",
      pluginId: "my-plugin",
      screenId: "my-screen",
    });
  });

  it("decodes percent-encoded segments", () => {
    expect(parseSettingsViewFromPathname("/settings/hosts/srv%20one/usage")).toEqual({
      kind: "host",
      serverId: "srv one",
      section: "usage",
    });
  });

  it("ignores search and hash", () => {
    expect(parseSettingsViewFromPathname("/settings/general?addHost=1")).toEqual({
      kind: "section",
      section: "general",
    });
  });

  it("falls back to the settings root when a host segment is empty", () => {
    expect(parseSettingsViewFromPathname("/settings/hosts")).toEqual({ kind: "root" });
    expect(parseSettingsViewFromPathname("/settings/hosts//usage")).toEqual({ kind: "root" });
  });
});
