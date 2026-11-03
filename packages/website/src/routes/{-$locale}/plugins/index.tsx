import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  Blocks,
  Boxes,
  ChevronRight,
  GitBranch,
  LayoutPanelLeft,
  type LucideIcon,
  Network,
  Palette,
  Server,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SiteShell } from "~/components/site-shell";
import { getTranslator, localizePath, routeLocale, useLocalizePath } from "~/i18n";
import { pageMeta } from "~/meta";
import {
  addedAgo,
  CATEGORIES,
  type CategorySlug,
  featuredPlugins,
  getCategory,
  getPluginsInCategory,
  getRegistry,
  type InstallWindow,
  mostInstalled,
  newestFirst,
  pluginOwner,
  recentlyUpdated,
  updatedAgo,
} from "~/plugins";
import { ContributeSection } from "~/plugins/contribute-links";
import { PluginsHero } from "~/plugins/hero";
import {
  type BrowseQuery,
  browseHref,
  categoryHref,
  DEFAULT_WINDOW,
  mostInstalledHref,
  parseSearchTerm,
  parseSort,
  parseWindow,
} from "~/plugins/links";
import { InstallCount } from "~/plugins/install-count";
import { PluginCard, PluginRankRow } from "~/plugins/plugin-card";
import { PluginSection, PluginSectionHeader, PluginSectionTitle } from "~/plugins/section";
import { WindowSwitch } from "~/plugins/window-switch";
import "~/styles.css";

const NEW_COUNT = 4;
const TOP_COUNT = 6;

const CATEGORY_ICONS: Record<CategorySlug, LucideIcon> = {
  "daemon-management": Server,
  themes: Palette,
  providers: Boxes,
  orchestration: Network,
  git: GitBranch,
  workspaces: Blocks,
  sidebar: LayoutPanelLeft,
  extras: Sparkles,
  utils: Wrench,
};

// Card sections: a swipeable row on phones, a grid from `sm` up.
const CARD_ROW_CLASS =
  "-mx-6 flex gap-4 overflow-x-auto px-6 pb-1 *:w-[70%] *:flex-shrink-0 sm:mx-0 sm:grid sm:grid-cols-2 sm:px-0 sm:*:w-auto lg:grid-cols-4";
const SEE_ALL_CLASS =
  "inline-flex items-center gap-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground";

export const Route = createFileRoute("/{-$locale}/plugins/")({
  validateSearch: (search: Record<string, unknown>): { window?: InstallWindow } => {
    const window = parseWindow(search.window);
    return window ? { window } : {};
  },
  beforeLoad: ({ location, params }) => {
    // Keep links from before browse pages existed: /plugins?q=<term>&category=<slug>&sort=new.
    const search = new URLSearchParams(location.searchStr);
    const category = getCategory(search.get("category") ?? "");
    const sort = parseSort(search.get("sort")) ?? "installs";
    const window = parseWindow(search.get("window")) ?? DEFAULT_WINDOW;
    const q = parseSearchTerm(search.get("q"));
    if (category || sort !== "installs" || q)
      throw redirect({
        href: localizePath(
          browseHref({ category: category ?? undefined, sort, window, q }),
          routeLocale(params),
        ),
        statusCode: 301,
      });
  },
  head: ({ params }) => {
    const locale = routeLocale(params);
    const t = getTranslator(locale);
    return pageMeta({
      title: t("plugins.meta.indexTitle"),
      description: t("plugins.meta.indexDescription"),
      path: "/plugins",
      locale,
    });
  },
  loader: () => getRegistry(),
  component: PluginsPage,
});

function PluginsPage() {
  const { plugins, featured: featuredIds, installs, now } = Route.useLoaderData();
  const window = Route.useSearch().window ?? DEFAULT_WINDOW;
  const { t } = useTranslation();
  const localize = useLocalizePath();
  const featured = featuredPlugins(plugins, featuredIds);
  const newest = newestFirst(plugins).slice(0, NEW_COUNT);
  const updated = recentlyUpdated(plugins).slice(0, NEW_COUNT);
  const top = mostInstalled(plugins, installs, window).slice(0, TOP_COUNT);
  const windowHrefs = useMemo(
    () => ({
      week: localize(mostInstalledHref("week")),
      month: localize(mostInstalledHref("month")),
      all: localize(mostInstalledHref("all")),
    }),
    [localize],
  );
  const searchScope = useMemo<BrowseQuery>(() => ({ sort: "installs", window }), [window]);
  const authorCount = new Set(plugins.map(pluginOwner)).size;

  return (
    <SiteShell width="default">
      <PluginsHero
        pluginCount={plugins.length}
        authorCount={authorCount}
        searchScope={searchScope}
      />

      <div className="mt-16 flex flex-col gap-14">
        {featured.length > 0 && (
          <PluginSection labelledBy="featured">
            <PluginSectionHeader>
              <div>
                <PluginSectionTitle id="featured">{t("plugins.featured")}</PluginSectionTitle>
                <p className="text-sm text-muted-foreground">{t("plugins.featuredDescription")}</p>
              </div>
              <a
                href={localize(browseHref({ sort: "installs", window: DEFAULT_WINDOW }))}
                className={SEE_ALL_CLASS}
              >
                {t("plugins.seeAll")}
                <ChevronRight className="h-3.5 w-3.5" />
              </a>
            </PluginSectionHeader>
            <div className={CARD_ROW_CLASS}>
              {featured.map((plugin) => (
                <PluginCard key={plugin.id} plugin={plugin}>
                  <InstallCount count={installs[plugin.id]?.all ?? 0} />
                </PluginCard>
              ))}
            </div>
          </PluginSection>
        )}

        <PluginSection labelledBy="whats-new">
          <PluginSectionHeader>
            <PluginSectionTitle id="whats-new">{t("plugins.whatsNew")}</PluginSectionTitle>
            <a
              href={localize(browseHref({ sort: "new", window: DEFAULT_WINDOW }))}
              className={SEE_ALL_CLASS}
            >
              {t("plugins.seeAll")}
              <ChevronRight className="h-3.5 w-3.5" />
            </a>
          </PluginSectionHeader>
          <div className={CARD_ROW_CLASS}>
            {newest.map((plugin) => (
              <PluginCard key={plugin.id} plugin={plugin}>
                {addedAgo(plugin, now, t)}
              </PluginCard>
            ))}
          </div>
        </PluginSection>

        {updated.length > 0 && (
          <PluginSection labelledBy="recently-updated">
            <PluginSectionHeader>
              <PluginSectionTitle id="recently-updated">
                {t("plugins.recentlyUpdated")}
              </PluginSectionTitle>
              <a
                href={localize(browseHref({ sort: "updated", window: DEFAULT_WINDOW }))}
                className={SEE_ALL_CLASS}
              >
                {t("plugins.seeAll")}
                <ChevronRight className="h-3.5 w-3.5" />
              </a>
            </PluginSectionHeader>
            <div className={CARD_ROW_CLASS}>
              {updated.map((plugin) => (
                <PluginCard key={plugin.id} plugin={plugin}>
                  {updatedAgo(plugin, now, t)}
                </PluginCard>
              ))}
            </div>
          </PluginSection>
        )}

        <PluginSection labelledBy="categories">
          <PluginSectionTitle id="categories">{t("plugins.categoriesTitle")}</PluginSectionTitle>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {CATEGORIES.map((category) => {
              const Icon = CATEGORY_ICONS[category];
              return (
                <a
                  key={category}
                  href={localize(categoryHref(category))}
                  className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3.5 transition-colors hover:border-white/20 hover:bg-white/[0.05] sm:px-4"
                >
                  <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 text-sm leading-tight text-white">
                    {t(`plugins.categories.${category}.label`)}
                  </span>
                  <span className="text-xs tabular-nums text-extra-muted-foreground">
                    {getPluginsInCategory(plugins, category).length}
                  </span>
                </a>
              );
            })}
          </div>
        </PluginSection>

        <PluginSection
          id="most-installed"
          labelledBy="most-installed-title"
          className="scroll-mt-8"
        >
          <PluginSectionHeader>
            <PluginSectionTitle id="most-installed-title">
              <a
                href={localize(browseHref({ sort: "installs", window }))}
                className="group inline-flex items-center gap-1"
              >
                {t("plugins.mostInstalled")}
                <ChevronRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
              </a>
            </PluginSectionTitle>
            <WindowSwitch current={window} hrefs={windowHrefs} />
          </PluginSectionHeader>
          <div className="-mx-4 grid gap-x-8 md:grid-cols-2">
            {top.map((plugin, index) => (
              <PluginRankRow
                key={plugin.id}
                plugin={plugin}
                rank={index + 1}
                installs={installs[plugin.id]?.[window] ?? 0}
              />
            ))}
          </div>
        </PluginSection>
      </div>

      <ContributeSection />
    </SiteShell>
  );
}
