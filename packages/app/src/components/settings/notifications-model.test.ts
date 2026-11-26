import { DEFAULT_NOTIFICATION_PREFERENCES } from "@getpaseo/protocol/notification-preferences";
import { describe, expect, it } from "vitest";
import {
  collectNotificationPluginIds,
  collectNotificationPlugins,
  hasConnectedHostMissingPushPreferences,
  setNotificationEventEnabled,
  setNotificationPluginMuted,
} from "./notifications-model";

describe("notifications settings model", () => {
  it("unions installed plugin IDs and muted plugin IDs in sorted unique order", () => {
    const installed = [{ id: "zeta-plugin" }, { id: "alpha-plugin" }, { id: "zeta-plugin" }];
    const muted = ["beta-removed-plugin", "alpha-plugin"];

    expect(collectNotificationPluginIds(installed, muted)).toEqual([
      "alpha-plugin",
      "beta-removed-plugin",
      "zeta-plugin",
    ]);
  });

  it("merges server-only configured plugins and display names with client-bundle and muted plugin IDs", () => {
    const configuredPlugins = [
      { id: "server-pipeline", name: "Server Pipeline" },
      { id: "shared-plugin", name: "Shared Plugin" },
      { id: "headless-id-only" },
    ];
    const installedPlugins = [{ id: "shared-plugin" }, { id: "client-only-plugin" }];
    const mutedPluginIds = ["removed-muted-plugin", "server-pipeline"];

    expect(
      collectNotificationPlugins({
        configuredPlugins,
        installedPlugins,
        mutedPluginIds,
      }),
    ).toEqual([
      { id: "client-only-plugin", label: "client-only-plugin" },
      { id: "headless-id-only", label: "headless-id-only" },
      { id: "removed-muted-plugin", label: "removed-muted-plugin" },
      { id: "server-pipeline", label: "Server Pipeline" },
      { id: "shared-plugin", label: "Shared Plugin" },
    ]);
  });

  it("mutes and unmutes individual plugins while keeping muted IDs normalized", () => {
    const mutedOnce = setNotificationPluginMuted(
      DEFAULT_NOTIFICATION_PREFERENCES,
      "ci-plugin",
      true,
    );
    expect(mutedOnce.plugins.muted).toEqual(["ci-plugin"]);

    const mutedTwice = setNotificationPluginMuted(mutedOnce, "alerts-plugin", true);
    expect(mutedTwice.plugins.muted).toEqual(["alerts-plugin", "ci-plugin"]);

    const unmuted = setNotificationPluginMuted(mutedTwice, "ci-plugin", false);
    expect(unmuted.plugins.muted).toEqual(["alerts-plugin"]);
  });

  it("updates individual built-in event switches without mutating other preferences", () => {
    const next = setNotificationEventEnabled(
      DEFAULT_NOTIFICATION_PREFERENCES,
      "agentFinished",
      true,
    );
    expect(next.events.agentFinished).toBe(true);
    expect(next.events.agentPermission).toBe(true);
    expect(next.events.agentError).toBe(true);
    expect(DEFAULT_NOTIFICATION_PREFERENCES.events.agentFinished).toBe(false);
  });

  it("detects when any connected host with serverInfo lacks pushNotificationPreferences", () => {
    const hosts = [{ serverId: "srv-new" }, { serverId: "srv-old" }];

    expect(
      hasConnectedHostMissingPushPreferences(hosts, {
        "srv-new": {
          serverInfo: {
            serverId: "srv-new",
            hostname: "new-host",
            version: "0.18.0",
            machineKind: null,
            capabilities: undefined,
            features: { pushNotificationPreferences: true },
          },
        },
        "srv-old": {
          serverInfo: {
            serverId: "srv-old",
            hostname: "old-host",
            version: "0.17.0",
            machineKind: null,
            capabilities: undefined,
            features: {},
          },
        },
      }),
    ).toBe(true);

    expect(
      hasConnectedHostMissingPushPreferences([{ serverId: "srv-new" }], {
        "srv-new": {
          serverInfo: {
            serverId: "srv-new",
            hostname: "new-host",
            version: "0.18.0",
            machineKind: null,
            capabilities: undefined,
            features: { pushNotificationPreferences: true },
          },
        },
      }),
    ).toBe(false);
  });
});
