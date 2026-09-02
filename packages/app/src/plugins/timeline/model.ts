import type {
  PluginTimelineData,
  PluginTimelineItem,
  PluginTimelineTransformResult,
} from "@getpaseo/plugin";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { InstalledPlugin } from "../types";

export interface InstalledPluginTimelineItem extends PluginTimelineItem {
  pluginId: string;
}

export type TimelineItemTransform = (
  item: AgentTimelineItem,
) => InstalledPluginTimelineItem[] | undefined;

function isTimelineData(value: unknown, ancestors: Set<object>): value is PluginTimelineData {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) return false;
  }

  ancestors.add(value);
  const values = Array.isArray(value) ? value : Object.values(value);
  const valid = values.every((child) => isTimelineData(child, ancestors));
  ancestors.delete(value);
  return valid;
}

function parseTransformResult(value: unknown): PluginTimelineTransformResult {
  if (!value || typeof value !== "object") {
    throw new Error("transform must return an object containing items");
  }
  const items = Reflect.get(value, "items");
  if (!Array.isArray(items)) throw new Error("transform result items must be an array");

  for (const item of items) {
    if (!item || typeof item !== "object" || Reflect.get(item, "type") !== "plugin") {
      throw new Error('transformed timeline items must have type "plugin"');
    }
    const kind = Reflect.get(item, "kind");
    const version = Reflect.get(item, "version");
    if (typeof kind !== "string" || !/^[a-z][a-z0-9-]*$/.test(kind)) {
      throw new Error(`invalid transformed timeline item kind: ${String(kind)}`);
    }
    if (!Number.isInteger(version) || Number(version) < 1) {
      throw new Error(`invalid transformed timeline item version: ${String(version)}`);
    }
    if (!isTimelineData(Reflect.get(item, "data"), new Set())) {
      throw new Error(`transformed timeline item ${kind} data must be JSON-compatible`);
    }
  }
  return { items: items as PluginTimelineItem[] };
}

export function transformTimelineItem(
  item: AgentTimelineItem,
  plugins: readonly InstalledPlugin[],
): InstalledPluginTimelineItem[] | undefined {
  for (const plugin of plugins) {
    for (const transformer of plugin.timelineTransformers) {
      if (transformer.query.itemType !== item.type) continue;
      try {
        const transform = transformer.transform as (input: {
          item: AgentTimelineItem;
        }) => PluginTimelineTransformResult | undefined;
        const output = transform({ item });
        if (output === undefined) continue;
        const parsed = parseTransformResult(output);
        return parsed.items.map((transformedItem) => ({
          type: "plugin",
          kind: transformedItem.kind,
          version: transformedItem.version,
          data: JSON.parse(JSON.stringify(transformedItem.data)) as PluginTimelineData,
          pluginId: plugin.id,
        }));
      } catch (error) {
        console.warn(
          `[Plugins] Timeline transformer failed: ${plugin.id}/${transformer.id}`,
          error,
        );
      }
    }
  }
  return undefined;
}
