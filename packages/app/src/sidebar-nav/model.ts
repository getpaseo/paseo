import type { PluginSidebarGroup } from "@/plugins/sidebar-groups";
import type { PluginSidebarSection } from "@/plugins/types";

export type SidebarSection = PluginSidebarSection;

/**
 * Each section's built-in items in their default order. The footer's bottom line
 * (Add project and the Hosts, Import session, Help and support, Settings icons) is fixed.
 */
export const BUILTIN_SIDEBAR_ITEM_IDS = {
  header: ["new-workspace", "history", "search", "schedules"],
  footer: ["usage"],
} as const satisfies Record<SidebarSection, readonly string[]>;

export type BuiltinSidebarItemId<Section extends SidebarSection = SidebarSection> =
  (typeof BUILTIN_SIDEBAR_ITEM_IDS)[Section][number];
export type BuiltinSidebarNavId = BuiltinSidebarItemId<"header">;

/** Persisted shape. Array order is the display order. */
export interface SidebarNavPreference {
  key: string;
  visible: boolean;
}

export interface BuiltinSidebarNavItem<Section extends SidebarSection = SidebarSection> {
  kind: "builtin";
  key: BuiltinSidebarItemId<Section>;
  id: BuiltinSidebarItemId<Section>;
  visible: boolean;
}

export interface PluginSidebarNavItem {
  kind: "plugin";
  key: string;
  group: PluginSidebarGroup;
  visible: boolean;
}

export type SidebarNavItem<Section extends SidebarSection = SidebarSection> =
  | BuiltinSidebarNavItem<Section>
  | PluginSidebarNavItem;

const BUILTIN_LABEL_KEYS: Record<BuiltinSidebarItemId, string> = {
  "new-workspace": "sidebar.actions.newWorkspace",
  history: "sidebar.sections.sessions",
  search: "sidebar.sections.search",
  schedules: "sidebar.sections.schedules",
  usage: "sidebar.footer.usage",
};

export function builtinSidebarNavLabelKey(id: BuiltinSidebarItemId): string {
  return BUILTIN_LABEL_KEYS[id];
}

/**
 * Shortcut action ids (`resolveShortcutKeysForAction`) for the builtins that have one.
 * Both the sidebar row and the Appearance settings row read the badge from here so the
 * two never disagree about which shortcut belongs to which item.
 */
const BUILTIN_SHORTCUT_ACTIONS: Record<BuiltinSidebarItemId, string | null> = {
  "new-workspace": "new-workspace",
  history: null,
  search: "toggle-command-center",
  schedules: null,
  usage: null,
};

export function builtinSidebarNavShortcutAction(id: BuiltinSidebarItemId): string | null {
  return BUILTIN_SHORTCUT_ACTIONS[id];
}

export function pluginSidebarNavKey(
  group: Pick<PluginSidebarGroup, "pluginId" | "contributionId">,
): string {
  return `plugin:${group.pluginId}:${group.contributionId}`;
}

function isBuiltinSidebarItemId<Section extends SidebarSection>(
  section: Section,
  key: string,
): key is BuiltinSidebarItemId<Section> {
  const ids: readonly string[] = BUILTIN_SIDEBAR_ITEM_IDS[section];
  return ids.includes(key);
}

export function resolveSidebarNavItems<Section extends SidebarSection>(input: {
  section: Section;
  pluginGroups: readonly PluginSidebarGroup[];
  preferences: readonly SidebarNavPreference[];
}): SidebarNavItem<Section>[] {
  const builtinIds: readonly BuiltinSidebarItemId<Section>[] =
    BUILTIN_SIDEBAR_ITEM_IDS[input.section];
  const groupsByKey = new Map(
    input.pluginGroups.map((group) => [pluginSidebarNavKey(group), group] as const),
  );
  const items: SidebarNavItem<Section>[] = [];
  const placed = new Set<string>();

  for (const preference of input.preferences) {
    if (placed.has(preference.key)) continue;
    const group = groupsByKey.get(preference.key);
    if (group) {
      placed.add(preference.key);
      items.push({ kind: "plugin", key: preference.key, group, visible: preference.visible });
    } else if (isBuiltinSidebarItemId(input.section, preference.key)) {
      placed.add(preference.key);
      items.push({
        kind: "builtin",
        key: preference.key,
        id: preference.key,
        visible: preference.visible,
      });
    }
  }

  for (const id of builtinIds) {
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
