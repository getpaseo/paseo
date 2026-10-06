import type { ReactNode } from "react";
import { AuthorAvatar } from "./author-link";
import { InstallCount } from "./install-count";
import { pluginCardScreenshot } from "./thumbnails";
import { pluginHref } from "./links";
import { PluginTile } from "./plugin-tile";
import { firstMediaImage, getAuthor, getCategory, type Plugin } from "./registry";

export const PLUGIN_GRID_CLASS =
  "grid gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";

/** First allowed image, or the plugin tile on a quiet backdrop when there is none. */
function PluginShot({ plugin }: { plugin: Plugin }) {
  const url = firstMediaImage(plugin);
  return (
    <div
      aria-hidden
      className="aspect-[16/10] overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] transition-colors group-hover:border-white/20"
    >
      {url ? (
        <img
          {...pluginCardScreenshot(plugin.id, url)}
          alt=""
          loading="lazy"
          decoding="async"
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

/**
 * What's new and Featured card, in three rows under the screenshot: tile and name, description,
 * then author and `children`, such as when the plugin was added or its install count.
 */
export function NewPluginCard({ plugin, children }: { plugin: Plugin; children?: ReactNode }) {
  const author = getAuthor(plugin);
  return (
    <a href={pluginHref(plugin.id)} className="group block w-[70%] flex-shrink-0 sm:w-auto">
      <PluginShot plugin={plugin} />
      <div className="mt-3 flex items-center gap-2">
        <PluginTile plugin={plugin} size="xs" />
        <p className="min-w-0 truncate text-sm font-medium text-white">{plugin.name}</p>
      </div>
      <p className="mt-2 line-clamp-2 min-h-10 text-xs leading-5 text-muted-foreground">
        {plugin.description}
      </p>
      <p className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-extra-muted-foreground">
        <AuthorAvatar author={author} size="xs" />
        <span className="truncate">{author.name}</span>
        {children !== undefined && (
          <>
            <span aria-hidden>·</span>
            <span className="flex-shrink-0">{children}</span>
          </>
        )}
      </p>
    </a>
  );
}

/** Grid card: screenshot; tile, name, and `children` such as an install count; description. */
export function PluginCard({ plugin, children }: { plugin: Plugin; children?: ReactNode }) {
  return (
    <a href={pluginHref(plugin.id)} className="group block">
      <PluginShot plugin={plugin} />
      <div className="mt-3 flex items-center gap-2">
        <PluginTile plugin={plugin} size="xs" />
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-white">{plugin.name}</p>
        <span className="flex-shrink-0 text-xs text-extra-muted-foreground">{children}</span>
      </div>
      <p className="mt-2 line-clamp-2 min-h-10 text-xs leading-5 text-muted-foreground">
        {plugin.description}
      </p>
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
      className="flex items-center gap-3 rounded-lg px-4 py-2.5 transition-colors hover:bg-white/[0.04]"
    >
      <span className="text-sm tabular-nums text-extra-muted-foreground">{rank}</span>
      <PluginTile plugin={plugin} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-white">{plugin.name}</p>
        <p className="truncate text-xs text-extra-muted-foreground">
          {getCategory(plugin.categories[0])?.label}
        </p>
      </div>
      <span className="text-xs text-muted-foreground">
        <InstallCount count={installs} />
      </span>
    </a>
  );
}
