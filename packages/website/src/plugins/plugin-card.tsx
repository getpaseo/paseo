import { Link } from "@tanstack/react-router";
import { Download } from "lucide-react";
import { useMemo } from "react";
import { PluginTile } from "./plugin-tile";
import { formatInstalls, getAuthor, getCategory, type Plugin } from "./registry";

export const PLUGIN_GRID_CLASS = "grid gap-3 sm:grid-cols-2 lg:grid-cols-3";

export function PluginCard({ plugin }: { plugin: Plugin }) {
  const author = getAuthor(plugin.author);
  const category = getCategory(plugin.categories[0]);
  const params = useMemo(
    () => ({ owner: plugin.author.github, slug: plugin.id.split("/")[1] }),
    [plugin.id, plugin.author.github],
  );
  return (
    <Link
      to="/plugins/$owner/$slug"
      params={params}
      className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4 hover:border-white/20 hover:bg-white/[0.05] transition-colors"
    >
      <div className="flex items-center gap-3">
        <PluginTile plugin={plugin} size="sm" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white">{plugin.name}</p>
          {author && <p className="truncate text-xs text-extra-muted-foreground">{author.name}</p>}
        </div>
      </div>
      <p className="line-clamp-2 flex-1 text-sm leading-relaxed text-muted-foreground">
        {plugin.description}
      </p>
      <div className="flex items-center justify-between gap-2 text-xs text-white/40">
        {category ? (
          <span className="truncate rounded-full border border-white/10 px-2 py-1">
            {category.label}
          </span>
        ) : (
          <span />
        )}
        {plugin.installs !== undefined && (
          <span className="inline-flex flex-shrink-0 items-center gap-1 tabular-nums">
            <Download className="h-3 w-3" />
            {formatInstalls(plugin.installs)} installs
          </span>
        )}
      </div>
    </Link>
  );
}
