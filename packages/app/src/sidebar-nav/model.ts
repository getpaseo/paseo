import type { PluginSidebarGroup } from "@/plugins/sidebar-groups";

export const BUILTIN_SIDEBAR_NAV_IDS = ["new-workspace", "history", "search", "schedules"] as const;
export type BuiltinSidebarNavId = (typeof BUILTIN_SIDEBAR_NAV_IDS)[number];

/** Persisted shape. Array order is the display order. */
export interface SidebarNavPreference {
  key: string;
  visible: boolean;
}

export interface BuiltinSidebarNavItem {
  kind: "builtin";
  key: BuiltinSidebarNavId;
  id: BuiltinSidebarNavId;
  visible: boolean;
}

export interface PluginSidebarNavItem {
  kind: "plugin";
  key: string;
  group: PluginSidebarGroup;
  visible: boolean;
}

export type SidebarNavItem = BuiltinSidebarNavItem | PluginSidebarNavItem;

const BUILTIN_LABEL_KEYS: Record<BuiltinSidebarNavId, string> = {
  "new-workspace": "sidebar.actions.newWorkspace",
  history: "sidebar.sections.sessions",
  search: "sidebar.sections.search",
  schedules: "sidebar.sections.schedules",
};

export function builtinSidebarNavLabelKey(id: BuiltinSidebarNavId): string {
  return BUILTIN_LABEL_KEYS[id];
}

/**
 * Shortcut action ids (`resolveShortcutKeysForAction`) for the builtins that have one.
 * Both the sidebar row and the Appearance settings row read the badge from here so the
 * two never disagree about which shortcut belongs to which item.
 */
const BUILTIN_SHORTCUT_ACTIONS: Record<BuiltinSidebarNavId, string | null> = {
  "new-workspace": "new-workspace",
  history: null,
  search: "toggle-command-center",
  schedules: null,
};

export function builtinSidebarNavShortcutAction(id: BuiltinSidebarNavId): string | null {
  return BUILTIN_SHORTCUT_ACTIONS[id];
}

export function pluginSidebarNavKey(
  group: Pick<PluginSidebarGroup, "pluginId" | "contributionId">,
): string {
  return `plugin:${group.pluginId}:${group.contributionId}`;
}

function isBuiltinSidebarNavId(key: string): key is BuiltinSidebarNavId {
  return (BUILTIN_SIDEBAR_NAV_IDS as readonly string[]).includes(key);
}

export function resolveSidebarNavItems(input: {
  pluginGroups: readonly PluginSidebarGroup[];
  preferences: readonly SidebarNavPreference[];
}): SidebarNavItem[] {
  const groupsByKey = new Map(
    input.pluginGroups.map((group) => [pluginSidebarNavKey(group), group] as const),
  );
  const items: SidebarNavItem[] = [];
  const placed = new Set<string>();

  for (const preference of input.preferences) {
    if (placed.has(preference.key)) continue;
    const group = groupsByKey.get(preference.key);
    if (group) {
      placed.add(preference.key);
      items.push({ kind: "plugin", key: preference.key, group, visible: preference.visible });
    } else if (isBuiltinSidebarNavId(preference.key)) {
      placed.add(preference.key);
      items.push({
        kind: "builtin",
        key: preference.key,
        id: preference.key,
        visible: preference.visible,
      });
    }
  }

  for (const id of BUILTIN_SIDEBAR_NAV_IDS) {
    if (placed.has(id)) continue;
    items.push({ kind: "builtin", key: id, id, visible: true });
  }
  for (const [key, group] of groupsByKey) {
    if (placed.has(key)) continue;
    items.push({ kind: "plugin", key, group, visible: true });
  }
  return items;
}

/**
 * Resolved items lead; entries for keys that are not currently available (a plugin that is
 * disconnected right now) follow so an unrelated edit does not erase them.
 */
function toPreferences(
  items: readonly SidebarNavItem[],
  previous: readonly SidebarNavPreference[],
): SidebarNavPreference[] {
  const remaining = items.map(({ key, visible }) => ({ key, visible }));
  const availableKeys = new Set(remaining.map((preference) => preference.key));
  const preferences: SidebarNavPreference[] = [];
  const seenPrevious = new Set<string>();

  for (const preference of previous) {
    if (seenPrevious.has(preference.key)) continue;
    seenPrevious.add(preference.key);

    if (availableKeys.has(preference.key)) {
      const next = remaining.shift();
      if (next) preferences.push(next);
      continue;
    }

    preferences.push({ key: preference.key, visible: preference.visible });
  }

  preferences.push(...remaining);
  return preferences;
}

export function setSidebarNavItemVisible(input: {
  items: readonly SidebarNavItem[];
  key: string;
  visible: boolean;
  previous: readonly SidebarNavPreference[];
}): SidebarNavPreference[] {
  const items = input.items.map((item) =>
    item.key === input.key ? { ...item, visible: input.visible } : item,
  );
  return toPreferences(items, input.previous);
}

export function moveSidebarNavItem(input: {
  items: readonly SidebarNavItem[];
  key: string;
  direction: "up" | "down";
  previous: readonly SidebarNavPreference[];
}): SidebarNavPreference[] {
  const from = input.items.findIndex((item) => item.key === input.key);
  const to = input.direction === "up" ? from - 1 : from + 1;
  const canMove = from !== -1 && to >= 0 && to < input.items.length;
  if (!canMove) {
    return toPreferences(input.items, input.previous);
  }
  const items = [...input.items];
  const [moved] = items.splice(from, 1);
  items.splice(to, 0, moved);
  return toPreferences(items, input.previous);
}
