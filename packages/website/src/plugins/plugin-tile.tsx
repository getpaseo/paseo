import { pluginOverviewUrl } from "@getpaseo/protocol/plugin-overview";
import type { Plugin } from "./registry";

const SIZE_CLASS = {
  sm: "h-9 w-9 rounded-lg text-sm",
  lg: "h-14 w-14 rounded-xl text-xl",
} as const;

/** PNG icon with a letter tile when no icon is published. */
export function PluginTile({ plugin, size }: { plugin: Plugin; size: keyof typeof SIZE_CLASS }) {
  return (
    <div
      aria-hidden
      className={`flex flex-shrink-0 items-center justify-center border border-white/10 bg-white/[0.06] font-medium text-white/80 ${SIZE_CLASS[size]}`}
    >
      {pluginOverviewUrl(plugin.icon) ? (
        <img src={plugin.icon} alt="" className="h-full w-full rounded-[inherit] object-cover" />
      ) : (
        plugin.name.charAt(0).toUpperCase()
      )}
    </div>
  );
}
