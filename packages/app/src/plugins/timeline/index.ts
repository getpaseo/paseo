import { useMemo } from "react";
import { useInstalledPlugins } from "../registry";
import { transformTimelineItem, type TimelineItemTransform } from "./model";

export type { InstalledPluginTimelineItem, TimelineItemTransform } from "./model";
export { PluginTimelineItemView } from "./view";

export function useInstalledTimelineTransform(serverId: string): TimelineItemTransform {
  const installed = useInstalledPlugins();
  const plugins = useMemo(
    () => installed.filter((plugin) => plugin.serverId === serverId),
    [installed, serverId],
  );
  return useMemo(() => (input) => transformTimelineItem({ ...input, plugins }), [plugins]);
}
