import type { InstalledPlugin } from "../types";

export interface SidebarViewEntry {
  id: string;
  title: string;
  plugin: InstalledPlugin;
  view: InstalledPlugin["sidebarViews"][number];
}

export function sidebarViews(plugins: readonly InstalledPlugin[]): SidebarViewEntry[] {
  const entries = new Map<string, SidebarViewEntry>();
  for (const plugin of plugins) {
    for (const view of plugin.sidebarViews) {
      const id = `${plugin.id}/${view.id}`;
      if (!entries.has(id))
        entries.set(id, {
          id,
          title: plugin.i18n.resolve(view.title, plugin.locale),
          plugin,
          view,
        });
    }
  }
  return [...entries.values()];
}
