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
  getCategory,
  getPluginsInCategory,
  getRegistry,
  type InstallWindow,
  mostInstalled,
  newestFirst,
} from "~/plugins";
import { ContributeLinks } from "~/plugins/contribute-links";
import {
  browseHref,
  categoryHref,
  DEFAULT_WINDOW,
  mostInstalledHref,
  parseSort,
  parseWindow,
} from "~/plugins/links";
import { NewPluginCard, PluginRankRow } from "~/plugins/plugin-card";
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

const SEE_ALL_CLASS =
  "inline-flex items-center gap-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground";

export const Route = createFileRoute("/plugins/")({
  validateSearch: (search: Record<string, unknown>): { window?: InstallWindow } => {
    const window = parseWindow(search.window);
    return window ? { window } : {};
  },
  beforeLoad: ({ location }) => {
    // Keep links from before browse pages existed: /plugins?category=<slug>&sort=new.
    const params = new URLSearchParams(location.searchStr);
    const category = getCategory(params.get("category") ?? "");
    const sort = parseSort(params.get("sort")) ?? "installs";
    if (category || sort === "new")
      throw redirect({
        href: browseHref({ category: category?.slug, sort, window: DEFAULT_WINDOW }),
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
  const { plugins, installs, now } = Route.useLoaderData();
  const window = Route.useSearch().window ?? DEFAULT_WINDOW;
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

  return (
    <SiteShell width="default">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-baseline sm:justify-between">
        <h1 className="text-3xl font-medium tracking-tight">
          Plugins
          <span className="ml-3 align-middle text-sm font-normal tabular-nums text-extra-muted-foreground">
            {plugins.length}
          </span>
        </h1>
        <div className="flex gap-5">
          <ContributeLinks />
        </div>
      </div>

      <section aria-labelledby="whats-new" className="mt-10">
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <h2 id="whats-new" className="text-lg font-medium">
            What’s new
          </h2>
          <a href={browseHref({ sort: "new", window: DEFAULT_WINDOW })} className={SEE_ALL_CLASS}>
            See all
            <ChevronRight className="h-3.5 w-3.5" />
          </a>
        </div>
        <div className="-mx-6 flex gap-4 overflow-x-auto px-6 pb-1 sm:mx-0 sm:grid sm:grid-cols-2 sm:px-0 lg:grid-cols-4">
          {newest.map((plugin) => (
            <NewPluginCard key={plugin.id} plugin={plugin} added={addedAgo(plugin, now)} />
          ))}
        </div>
      </section>

      <section aria-labelledby="categories" className="mt-14">
        <h2 id="categories" className="mb-4 text-lg font-medium">
          Categories
        </h2>
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
      </section>

      <section
        id="most-installed"
        aria-labelledby="most-installed-title"
        className="mt-14 scroll-mt-8"
      >
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <h2 id="most-installed-title" className="text-lg font-medium">
            <a
              href={browseHref({ sort: "installs", window })}
              className="group inline-flex items-center gap-1"
            >
              Most installed
              <ChevronRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
            </a>
          </h2>
          <WindowSwitch current={window} hrefs={windowHrefs} />
        </div>
        <div className="-mx-2 grid gap-x-8 md:grid-cols-2">
          {top.map((plugin, index) => (
            <PluginRankRow
              key={plugin.id}
              plugin={plugin}
              rank={index + 1}
              installs={installs[plugin.id]?.[window] ?? 0}
            />
          ))}
        </div>
      </section>
    </SiteShell>
  );
}
