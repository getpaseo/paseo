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
import { SiteShell } from "~/components/site-shell";
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
import { NewPluginCard, PluginRankRow } from "~/plugins/plugin-card";
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

// What's new and Featured cards: a swipeable row on phones, a grid from `sm` up.
const CARD_ROW_CLASS =
  "-mx-6 flex gap-4 overflow-x-auto px-6 pb-1 sm:mx-0 sm:grid sm:grid-cols-2 sm:px-0 lg:grid-cols-4";
const SEE_ALL_CLASS =
  "inline-flex items-center gap-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground";

export const Route = createFileRoute("/plugins/")({
  validateSearch: (search: Record<string, unknown>): { window?: InstallWindow } => {
    const window = parseWindow(search.window);
    return window ? { window } : {};
  },
  beforeLoad: ({ location }) => {
    // Keep links from before browse pages existed: /plugins?q=<term>&category=<slug>&sort=new.
    const params = new URLSearchParams(location.searchStr);
    const category = getCategory(params.get("category") ?? "");
    const sort = parseSort(params.get("sort")) ?? "installs";
    const window = parseWindow(params.get("window")) ?? DEFAULT_WINDOW;
    const q = parseSearchTerm(params.get("q"));
    if (category || sort === "new" || q)
      throw redirect({
        href: browseHref({ category: category?.slug, sort, window, q }),
        statusCode: 301,
      });
  },
  head: () =>
    pageMeta(
      "Plugins – Extend Paseo with community plugins",
      "Themes, providers, panels, and automations built by the Paseo community. Install any of them with one command.",
      "/plugins",
    ),
  loader: () => getRegistry(),
  component: PluginsPage,
});

function PluginsPage() {
  const { plugins, featured: featuredIds, installs, now } = Route.useLoaderData();
  const window = Route.useSearch().window ?? DEFAULT_WINDOW;
  const featured = featuredPlugins(plugins, featuredIds);
  const newest = newestFirst(plugins).slice(0, NEW_COUNT);
  const top = mostInstalled(plugins, installs, window).slice(0, TOP_COUNT);
  const windowHrefs = useMemo(
    () => ({
      week: mostInstalledHref("week"),
      month: mostInstalledHref("month"),
      all: mostInstalledHref("all"),
    }),
    [],
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
                <PluginSectionTitle id="featured">Featured</PluginSectionTitle>
                <p className="text-sm text-muted-foreground">
                  A selection of hand picked plugins
                </p>
              </div>
              <a
                href={browseHref({ sort: "installs", window: DEFAULT_WINDOW })}
                className={SEE_ALL_CLASS}
              >
                See all
                <ChevronRight className="h-3.5 w-3.5" />
              </a>
            </PluginSectionHeader>
            <div className={CARD_ROW_CLASS}>
              {featured.map((plugin) => (
                <NewPluginCard key={plugin.id} plugin={plugin}>
                  <InstallCount count={installs[plugin.id]?.all ?? 0} />
                </NewPluginCard>
              ))}
            </div>
          </PluginSection>
        )}

        <PluginSection labelledBy="whats-new">
          <PluginSectionHeader>
            <PluginSectionTitle id="whats-new">What’s new</PluginSectionTitle>
            <a href={browseHref({ sort: "new", window: DEFAULT_WINDOW })} className={SEE_ALL_CLASS}>
              See all
              <ChevronRight className="h-3.5 w-3.5" />
            </a>
          </PluginSectionHeader>
          <div className={CARD_ROW_CLASS}>
            {newest.map((plugin) => (
              <NewPluginCard key={plugin.id} plugin={plugin}>
                {addedAgo(plugin, now)}
              </NewPluginCard>
            ))}
          </div>
        </PluginSection>

        <PluginSection labelledBy="categories">
          <PluginSectionTitle id="categories">Categories</PluginSectionTitle>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {CATEGORIES.map((category) => {
              const Icon = CATEGORY_ICONS[category.slug];
              return (
                <a
                  key={category.slug}
                  href={categoryHref(category.slug)}
                  className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3.5 transition-colors hover:border-white/20 hover:bg-white/[0.05] sm:px-4"
                >
                  <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 text-sm leading-tight text-white">
                    {category.label}
                  </span>
                  <span className="text-xs tabular-nums text-extra-muted-foreground">
                    {getPluginsInCategory(plugins, category.slug).length}
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
                href={browseHref({ sort: "installs", window })}
                className="group inline-flex items-center gap-1"
              >
                Most installed
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
