import { Download } from "lucide-react";
import { pluginHref } from "./links";
import { PluginTile } from "./plugin-tile";
import { formatInstalls, getCategory, type Plugin } from "./registry";

export const PLUGIN_GRID_CLASS =
  "grid gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";

/** First screenshot, or the plugin tile on a quiet backdrop when there is none. */
function PluginShot({ plugin }: { plugin: Plugin }) {
  const url = plugin.screenshots[0];
  return (
    <div
      aria-hidden
      className="aspect-[16/10] overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] transition-colors group-hover:border-white/20"
    >
      {url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover object-left-top"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_30%_20%,rgba(35,153,86,0.12),transparent_60%)]">
          <PluginTile plugin={plugin} size="lg" />
        </div>
      )}
    </div>
  );
}

/** What's new card: screenshot, name, and when it was added. */
export function NewPluginCard({ plugin, added }: { plugin: Plugin; added: string }) {
  return (
    <a href={pluginHref(plugin.id)} className="group block w-[70%] flex-shrink-0 sm:w-auto">
      <PluginShot plugin={plugin} />
      <div className="mt-3 flex items-center gap-2.5">
        <PluginTile plugin={plugin} size="sm" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white">{plugin.name}</p>
          <p className="truncate text-xs text-extra-muted-foreground">Added {added}</p>
        </div>
      </div>
    </a>
  );
}

/** Grid card: screenshot, name, one muted stat, and a two-line description. */
export function PluginCard({
  plugin,
  installs,
  added,
}: {
  plugin: Plugin;
  /** Shown with a download icon; otherwise `added` is shown. */
  installs?: number;
  added?: string;
}) {
  return (
    <a href={pluginHref(plugin.id)} className="group block">
      <PluginShot plugin={plugin} />
      <div className="mt-3 flex items-start gap-2.5">
        <PluginTile plugin={plugin} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="truncate text-sm font-medium text-white">{plugin.name}</p>
            <span className="inline-flex flex-shrink-0 items-center gap-1 text-xs tabular-nums text-extra-muted-foreground">
              {installs === undefined ? (
                added
              ) : (
                <>
                  <Download className="h-3 w-3" />
                  {formatInstalls(installs)}
                </>
              )}
            </span>
          </div>
          <p className="mt-0.5 line-clamp-2 min-h-10 text-xs leading-5 text-muted-foreground">
            {plugin.description}
          </p>
        </div>
      </div>
    </a>
  );
}

/** Ranked row for the directory's Most installed list. */
export function PluginRankRow({
  plugin,
  rank,
  installs,
}: {
  plugin: Plugin;
  rank: number;
  installs: number;
}) {
  return (
    <a
      href={pluginHref(plugin.id)}
      className="flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-white/[0.04]"
    >
      <span className="w-4 text-right text-sm tabular-nums text-extra-muted-foreground">
        {rank}
      </span>
      <PluginTile plugin={plugin} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-white">{plugin.name}</p>
        <p className="truncate text-xs text-extra-muted-foreground">
          {getCategory(plugin.categories[0])?.label}
        </p>
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">{formatInstalls(installs)}</span>
    </a>
  );
}
