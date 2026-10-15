import { ContributeButtons } from "./contribute-links";
import type { BrowseQuery } from "./links";
import { PluginSearch } from "./plugin-search";

interface PluginsHeroProps {
  pluginCount: number;
  authorCount: number;
  /** Where the search box sends its term. */
  searchScope: BrowseQuery;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Header of the plugin directory: title, counts, and copy, then the contribute buttons and search. */
export function PluginsHero({ pluginCount, authorCount, searchScope }: PluginsHeroProps) {
  return (
    <header>
      <h1 className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-3xl font-medium tracking-tight">Plugins</span>
        <span className="text-sm font-normal tabular-nums text-extra-muted-foreground">
          {plural(pluginCount, "plugin")} by {plural(authorCount, "author")}
        </span>
      </h1>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
        Browse community plugins that extend Paseo with new functionality.
      </p>
      <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-3">
          <ContributeButtons />
        </div>
        <PluginSearch scope={searchScope} className="w-full sm:w-64" />
      </div>
    </header>
  );
}
