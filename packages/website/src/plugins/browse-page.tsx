import type { TFunction } from "i18next";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SiteShell } from "~/components/site-shell";
import { useLocale, useLocalizePath } from "~/i18n";
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
  recentlyUpdated,
  searchPlugins,
  updatedAgo,
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

/** All plugins or one category: sidebar, Most installed / Newest / Recently updated tabs, and the card grid. */
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
  const { t } = useTranslation();
  const locale = useLocale();
  const localize = useLocalizePath();
  const category = query.category ? getCategory(query.category) : null;
  const ordered = sortPlugins(plugins, installs, query);
  // Search ranks by relevance; the tab's order breaks ties.
  const matches = query.q ? searchPlugins(ordered, query.q, locale) : ordered;
  const results = category ? getPluginsInCategory(matches, category) : matches;
  const categoryLabel = category ? t(`plugins.categories.${category}.label`) : undefined;
  const title = categoryLabel ?? t("plugins.allPlugins");
  const clearHref = localize(browseHref({ ...query, q: undefined }));
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
              {resultsTitle({ term: query.q, categoryLabel, title, t })}
              <span className="ml-3 align-middle text-sm font-normal tabular-nums text-extra-muted-foreground">
                {results.length}
              </span>
            </h1>
            {query.q && (
              <a href={clearHref} className={CLEAR_CLASS}>
                {t("plugins.clear")}
              </a>
            )}
          </div>
          <PluginSection>
            <SortTabs query={query} />
            {results.length === 0 && query.q && (
              <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-10 text-center">
                <p className="text-sm text-muted-foreground">{t("plugins.noMatches")}</p>
                <a
                  href={clearHref}
                  className="mt-2 inline-block text-xs text-extra-muted-foreground transition-colors hover:text-muted-foreground"
                >
                  {t("plugins.clearFilters")}
                </a>
              </div>
            )}
            {results.length === 0 && !query.q && (
              <p className="text-sm text-muted-foreground">
                {query.sort === "updated" ? t("plugins.noneUpdated") : t("plugins.noneInCategory")}
              </p>
            )}
            {results.length > 0 && (
              <div className={PLUGIN_GRID_CLASS}>
                {results.map((plugin) => (
                  <PluginCard key={plugin.id} plugin={plugin}>
                    <CardDetail plugin={plugin} installs={installs} now={now} query={query} />
                  </PluginCard>
                ))}
              </div>
            )}
          </PluginSection>
        </div>
      </div>
    </SiteShell>
  );
}

/** The heading: the category or all plugins, or the search term and where it searched. */
function resultsTitle({
  term,
  categoryLabel,
  title,
  t,
}: {
  term: string | undefined;
  categoryLabel: string | undefined;
  title: string;
  t: TFunction;
}): string {
  if (!term) return title;
  return categoryLabel
    ? t("plugins.resultsInCategory", { term, category: categoryLabel })
    : t("plugins.results", { term });
}

function sortPlugins(
  plugins: Plugin[],
  installs: Record<string, InstallCounts>,
  query: BrowseQuery,
): Plugin[] {
  if (query.sort === "new") return newestFirst(plugins);
  if (query.sort === "updated") return recentlyUpdated(plugins);
  return mostInstalled(plugins, installs, query.window);
}

/** What the card shows beside the author: the date the tab sorts by, or the install count. */
function CardDetail({
  plugin,
  installs,
  now,
  query,
}: {
  plugin: Plugin;
  installs: Record<string, InstallCounts>;
  now: string;
  query: BrowseQuery;
}) {
  const { t } = useTranslation();
  if (query.sort === "new") return addedAgo(plugin, now, t);
  if (query.sort === "updated") return updatedAgo(plugin, now, t);
  return <InstallCount count={installs[plugin.id]?.[query.window] ?? 0} />;
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
  const { t } = useTranslation();
  const localize = useLocalizePath();
  const entries: NavEntry[] = [
    {
      href: localize(browseHref({ ...query, category: undefined })),
      label: t("plugins.allPlugins"),
      chip: t("plugins.allChip"),
      count: plugins.length,
    },
    ...CATEGORIES.map((category) => ({
      href: localize(browseHref({ ...query, category })),
      label: t(`plugins.categories.${category}.label`),
      chip: t(`plugins.categories.${category}.label`),
      slug: category,
      count: getPluginsInCategory(plugins, category).length,
    })),
  ];
  return (
    <>
      <nav aria-label={t("plugins.categoriesTitle")} className="-ml-2.5 hidden lg:block">
        {entries.map((entry, index) => (
          <div key={entry.href}>
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
      <nav
        aria-label={t("plugins.categoriesTitle")}
        className="-mx-6 flex gap-2 overflow-x-auto px-6 pb-1 lg:hidden"
      >
        {entries.map((entry) => (
          <a
            key={entry.href}
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
  const { t } = useTranslation();
  const localize = useLocalizePath();
  const windowHrefs = useMemo(
    () => ({
      week: localize(browseHref({ ...query, window: "week" })),
      month: localize(browseHref({ ...query, window: "month" })),
      all: localize(browseHref({ ...query, window: "all" })),
    }),
    [localize, query],
  );
  const windowSwitch = query.sort === "installs" && (
    <WindowSwitch current={query.window} hrefs={windowHrefs} />
  );
  return (
    <div>
      <div className="flex items-baseline justify-between gap-6 border-b border-white/10">
        <div className="flex gap-6">
          <a
            href={localize(browseHref({ ...query, sort: "installs" }))}
            aria-current={query.sort === "installs" ? "page" : undefined}
            className={query.sort === "installs" ? TAB_ON : TAB_OFF}
          >
            {t("plugins.mostInstalled")}
          </a>
          <a
            href={localize(browseHref({ ...query, sort: "new" }))}
            aria-current={query.sort === "new" ? "page" : undefined}
            className={query.sort === "new" ? TAB_ON : TAB_OFF}
          >
            {t("plugins.newest")}
          </a>
          <a
            href={localize(browseHref({ ...query, sort: "updated" }))}
            aria-current={query.sort === "updated" ? "page" : undefined}
            className={query.sort === "updated" ? TAB_ON : TAB_OFF}
          >
            {t("plugins.recentlyUpdated")}
          </a>
        </div>
        {windowSwitch && <div className="hidden pb-2 sm:block">{windowSwitch}</div>}
      </div>
      {windowSwitch && <div className="mt-4 sm:hidden">{windowSwitch}</div>}
    </div>
  );
}
