import type {
  PluginFloatingWidgetContribution,
  PluginFloatingWidgetPosition,
  PluginFloatingWidgetSize,
  PluginText,
} from "@getpaseo/plugin/client";
import type { InstalledPlugin } from "../types";

export interface EvaluatedFloatingWidget {
  contribution: PluginFloatingWidgetContribution<PluginText>;
  visible: boolean;
  revealRevision: number;
  show(): void;
  hide(): void;
}

export interface FloatingWidgetTarget {
  plugin: InstalledPlugin;
  widget: EvaluatedFloatingWidget;
}

let revealSequence = 0;

/** A show request chooses its installation even when another host supplied the current widget. */
export function nextFloatingWidgetReveal(): number {
  revealSequence += 1;
  return revealSequence;
}

export interface FloatingWidgetGroup {
  key: string;
  targets: FloatingWidgetTarget[];
}

/** One surface per plugin/widget, independent of connection or catalog arrival order. */
export function groupFloatingWidgets(plugins: readonly InstalledPlugin[]): FloatingWidgetGroup[] {
  const groups = new Map<string, FloatingWidgetGroup>();
  for (const plugin of plugins) {
    for (const widget of plugin.floatingWidgets) {
      const key = `${plugin.id}/${widget.contribution.id}`;
      const group = groups.get(key) ?? { key, targets: [] };
      group.targets.push({ plugin, widget });
      groups.set(key, group);
    }
  }
  const result = [...groups.values()];
  for (const group of result) {
    group.targets.sort((a, b) => a.plugin.serverId.localeCompare(b.plugin.serverId));
  }
  return result.sort((a, b) => a.key.localeCompare(b.key));
}

export function selectFloatingWidgetTarget(
  group: FloatingWidgetGroup,
  preferredHost: string | null,
): FloatingWidgetTarget {
  let requested: FloatingWidgetTarget | undefined;
  for (const target of group.targets) {
    if (target.widget.revealRevision > (requested?.widget.revealRevision ?? 0)) requested = target;
  }
  return (
    requested ??
    group.targets.find((target) => target.plugin.serverId === preferredHost) ??
    group.targets[0]!
  );
}

export interface WidgetPoint {
  x: number;
  y: number;
}

export interface WidgetBounds extends WidgetPoint, PluginFloatingWidgetSize {}

export function floatingWidgetBounds(
  viewport: PluginFloatingWidgetSize,
  insets: { top: number; right: number; bottom: number; left: number },
  keyboardShift: number,
): WidgetBounds {
  const gutter = 8;
  const x = Math.min(viewport.width, insets.left + gutter);
  const y = Math.min(viewport.height, insets.top + gutter);
  return {
    x,
    y,
    width: Math.max(0, viewport.width - x - insets.right - gutter),
    height: Math.max(0, viewport.height - y - insets.bottom - keyboardShift - gutter),
  };
}

export function clampWidgetPosition(
  position: WidgetPoint,
  size: PluginFloatingWidgetSize,
  bounds: WidgetBounds,
): WidgetPoint {
  return {
    x: Math.max(bounds.x, Math.min(position.x, bounds.x + Math.max(0, bounds.width - size.width))),
    y: Math.max(
      bounds.y,
      Math.min(position.y, bounds.y + Math.max(0, bounds.height - size.height)),
    ),
  };
}

export function initialWidgetPosition(
  corner: PluginFloatingWidgetPosition,
  size: PluginFloatingWidgetSize,
  bounds: WidgetBounds,
): WidgetPoint {
  return clampWidgetPosition(
    {
      x: corner.endsWith("right") ? bounds.x + bounds.width - size.width : bounds.x,
      y: corner.startsWith("bottom") ? bounds.y + bounds.height - size.height : bounds.y,
    },
    size,
    bounds,
  );
}
