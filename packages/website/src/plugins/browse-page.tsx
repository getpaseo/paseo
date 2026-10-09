import { useMemo } from "react";
import { SiteShell } from "~/components/site-shell";
import { ContributeLinks } from "./contribute-links";
import type { InstallCounts } from "./installs";
import { type BrowseQuery, browseHref } from "./links";
import { InstallCount } from "./install-count";
import { PLUGIN_GRID_CLASS, PluginCard } from "./plugin-card";
import { PluginSearch } from "./plugin-search";
import { PluginSection } from "./section";
import {
  addedAgo,
  CATEGORIES,
  type CategorySlug,
  getCategory,
  getPluginsInCategory,
  mostInstalled,
  newestFirst,
  type Plugin,
  searchPlugins,
} from "./registry";
import { WindowSwitch } from "./window-switch";

const NAV_BASE =
  "flex items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-sm transition-colors";
const NAV_ON = `${NAV_BASE} bg-white/[0.06] text-white`;
const NAV_OFF = `${NAV_BASE} text-muted-foreground hover:text-foreground`;
const CHIP_BASE =
  "inline-flex flex-shrink-0 items-center rounded-full border px-3 py-1.5 text-xs transition-colors";
const CHIP_ON = `${CHIP_BASE} border-white/20 bg-white/[0.07] text-white`;
const CHIP_OFF = `${CHIP_BASE} border-white/10 text-muted-foreground`;
const TAB_BASE = "-mb-px border-b pb-2 text-sm transition-colors";
const TAB_ON = `${TAB_BASE} border-white text-white`;
const TAB_OFF = `${TAB_BASE} border-transparent text-muted-foreground hover:text-foreground`;
const CLEAR_CLASS =
  "text-sm text-extra-muted-foreground transition-colors hover:text-muted-foreground";

/** All plugins or one category: sidebar, Most installed / Newest tabs, and the card grid. */
export function BrowsePage({
  plugins,
  installs,
  now,
  query,
}: {
  plugins: Plugin[];
  installs: Record<string, InstallCounts>;
  now: string;
  query: BrowseQuery;
}) {
  const category = query.category ? getCategory(query.category) : null;
  const ordered =
    query.sort === "new" ? newestFirst(plugins) : mostInstalled(plugins, installs, query.window);
  // Search ranks by relevance; the tab's order breaks ties.
  const matches = query.q ? searchPlugins(ordered, query.q) : ordered;
  const results = category ? getPluginsInCategory(matches, category.slug) : matches;
  const title = category?.label ?? "All plugins";
  const clearHref = browseHref({ ...query, q: undefined });
  return (
    <SiteShell width="wide">
      <div className="lg:flex lg:gap-12">
        <aside className="mb-8 lg:mb-0 lg:w-48 lg:flex-shrink-0">
          <PluginSearch scope={query} live className="mb-4 lg:mb-6" />
          <CategoryNav plugins={matches} query={query} />
        </aside>
        <div className="min-w-0 flex-1">
          <div className="mb-6 flex items-baseline justify-between gap-4">
            <h1 className="text-3xl font-medium tracking-tight">
              {query.q ? `Results for “${query.q}”${category ? ` in ${title}` : ""}` : title}
              <span className="ml-3 align-middle text-sm font-normal tabular-nums text-extra-muted-foreground">
                {results.length}
              </span>
            </h1>
            {query.q && (
              <a href={clearHref} className={CLEAR_CLASS}>
                Clear
              </a>
            )}
          </div>
          <PluginSection>
            <SortTabs query={query} />
            {results.length === 0 && query.q && (
              <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-10 text-center">
                <p className="text-sm text-muted-foreground">No plugins match.</p>
                <a
                  href={clearHref}
                  className="mt-2 inline-block text-xs text-extra-muted-foreground transition-colors hover:text-muted-foreground"
                >
                  Clear filters
                </a>
              </div>
            )}
            {results.length === 0 && !query.q && (
              <p className="text-sm text-muted-foreground">No plugins in this category yet.</p>
            )}
            {results.length > 0 && (
              <div className={PLUGIN_GRID_CLASS}>
                {results.map((plugin) =>
                  query.sort === "new" ? (
                    <PluginCard key={plugin.id} plugin={plugin}>
                      {addedAgo(plugin, now)}
                    </PluginCard>
                  ) : (
                    <PluginCard key={plugin.id} plugin={plugin}>
                      <InstallCount count={installs[plugin.id]?.[query.window] ?? 0} />
                    </PluginCard>
                  ),
                )}
              </div>
            )}
          </PluginSection>
        </div>
      </div>
    </SiteShell>
  );
}

interface NavEntry {
  href: string;
  label: string;
  chip: string;
  /** Absent for all plugins. */
  slug?: CategorySlug;
  count: number;
}

/** Category sidebar on wide screens, a row of chips on narrow ones. Counts follow the search. */
function CategoryNav({ plugins, query }: { plugins: Plugin[]; query: BrowseQuery }) {
  const entries: NavEntry[] = [
    {
      href: browseHref({ ...query, category: undefined }),
      label: "All plugins",
      chip: "All",
      count: plugins.length,
    },
    ...CATEGORIES.map((category) => ({
      href: browseHref({ ...query, category: category.slug }),
      label: category.label,
      chip: category.label,
      slug: category.slug,
      count: getPluginsInCategory(plugins, category.slug).length,
    })),
  ];
  return (
    <>
      <nav aria-label="Categories" className="-ml-2.5 hidden lg:block">
        {entries.map((entry, index) => (
          <div key={entry.label}>
            <a
              href={entry.href}
              aria-current={query.category === entry.slug ? "page" : undefined}
              className={query.category === entry.slug ? NAV_ON : NAV_OFF}
            >
              {entry.label}
              <span className="text-xs tabular-nums text-extra-muted-foreground">
                {entry.count}
              </span>
            </a>
            {index === 0 && <div className="my-3 h-px bg-white/10" />}
          </div>
        ))}
        <div className="my-3 h-px bg-white/10" />
        <div className="flex flex-col gap-1.5 px-2.5">
          <ContributeLinks />
        </div>
      </nav>
      <nav aria-label="Categories" className="-mx-6 flex gap-2 overflow-x-auto px-6 pb-1 lg:hidden">
        {entries.map((entry) => (
          <a
            key={entry.label}
            href={entry.href}
            aria-current={query.category === entry.slug ? "page" : undefined}
            className={query.category === entry.slug ? CHIP_ON : CHIP_OFF}
          >
            {entry.chip}
          </a>
        ))}
      </nav>
    </>
  );
}

function SortTabs({ query }: { query: BrowseQuery }) {
  const windowHrefs = useMemo(
    () => ({
      week: browseHref({ ...query, window: "week" }),
      month: browseHref({ ...query, window: "month" }),
      all: browseHref({ ...query, window: "all" }),
    }),
    [query],
  );
  const windowSwitch = query.sort === "installs" && (
    <WindowSwitch current={query.window} hrefs={windowHrefs} />
  );
  return (
    <div>
      <div className="flex items-baseline justify-between gap-6 border-b border-white/10">
        <div className="flex gap-6">
          <a
            href={browseHref({ ...query, sort: "installs" })}
            aria-current={query.sort === "installs" ? "page" : undefined}
            className={query.sort === "installs" ? TAB_ON : TAB_OFF}
          >
            Most installed
          </a>
          <a
            href={browseHref({ ...query, sort: "new" })}
            aria-current={query.sort === "new" ? "page" : undefined}
            className={query.sort === "new" ? TAB_ON : TAB_OFF}
          >
            Newest
          </a>
        </div>
        {windowSwitch && <div className="hidden pb-2 sm:block">{windowSwitch}</div>}
      </div>
      {windowSwitch && <div className="mt-4 sm:hidden">{windowSwitch}</div>}
    </div>
  );
}
