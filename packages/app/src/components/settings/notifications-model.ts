import {
  normalizeNotificationPreferences,
  type NotificationPreferences,
} from "@getpaseo/protocol/notification-preferences";
import type { HostFeatureSessionState } from "@/runtime/host-features";

export type NotificationEventKey = keyof NotificationPreferences["events"];

export interface NotificationPluginEntry {
  id: string;
  label: string;
}

export function collectNotificationPlugins(input: {
  configuredPlugins?: readonly { id: string; name?: string }[];
  installedPlugins: readonly { id: string; name?: string }[];
  mutedPluginIds: readonly string[];
}): NotificationPluginEntry[] {
  const byId = new Map<string, string>();

  const recordPlugin = (id: string, name?: string) => {
    const trimmedId = id.trim();
    if (trimmedId.length === 0) {
      return;
    }
    const trimmedName = typeof name === "string" ? name.trim() : "";
    const existing = byId.get(trimmedId);
    if (!existing || existing === trimmedId) {
      byId.set(trimmedId, trimmedName.length > 0 ? trimmedName : trimmedId);
    }
  };

  for (const plugin of input.configuredPlugins ?? []) {
    recordPlugin(plugin.id, plugin.name);
  }
  for (const plugin of input.installedPlugins) {
    recordPlugin(plugin.id, plugin.name);
  }
  for (const mutedId of input.mutedPluginIds) {
    recordPlugin(mutedId);
  }

  return Array.from(byId.entries())
    .sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
    .map(([id, label]) => ({ id, label }));
}

export function collectNotificationPluginIds(
  installedPlugins: readonly { id: string }[],
  mutedPluginIds: readonly string[],
): string[] {
  return collectNotificationPlugins({ installedPlugins, mutedPluginIds }).map((entry) => entry.id);
}

export function setNotificationEventEnabled(
  preferences: NotificationPreferences,
  eventKey: NotificationEventKey,
  enabled: boolean,
): NotificationPreferences {
  return normalizeNotificationPreferences({
    ...preferences,
    events: {
      ...preferences.events,
      [eventKey]: enabled,
    },
  });
}

export function setNotificationPluginMuted(
  preferences: NotificationPreferences,
  pluginId: string,
  muted: boolean,
): NotificationPreferences {
  const currentMuted = new Set(preferences.plugins.muted);
  if (muted) {
    currentMuted.add(pluginId);
  } else {
    currentMuted.delete(pluginId);
  }
  return normalizeNotificationPreferences({
    ...preferences,
    plugins: {
      ...preferences.plugins,
      muted: Array.from(currentMuted),
    },
  });
}

export function hasConnectedHostMissingPushPreferences(
  hosts: readonly { serverId: string }[],
  sessions: HostFeatureSessionState["sessions"],
): boolean {
  for (const host of hosts) {
    const serverInfo = sessions[host.serverId]?.serverInfo;
    if (!serverInfo) {
      continue;
    }
    // COMPAT(pushNotificationPreferences): added in v0.18.0, remove gate after 2027-06-01.
    if (serverInfo.features?.pushNotificationPreferences !== true) {
      return true;
    }
  }
  return false;
}
