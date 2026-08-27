import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { pluginRegistry } from "../registry";
import {
  transformTimelineItem,
  type InstalledPluginTimelineItem,
  type TimelineItemTransform,
} from "./model";

export type { InstalledPluginTimelineItem, TimelineItemTransform } from "./model";
export { createPluginTimelineItemSource } from "./source";
export { PluginTimelineItemView } from "./view";

export function createInstalledTimelineTransform(serverId: string): TimelineItemTransform {
  return (item: AgentTimelineItem, source): InstalledPluginTimelineItem[] | undefined => {
    const plugins = pluginRegistry.getSnapshot().filter((plugin) => plugin.serverId === serverId);
    return transformTimelineItem(item, plugins, source);
  };
}
