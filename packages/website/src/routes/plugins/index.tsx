import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { type ChangeEvent, useCallback } from "react";
import { SiteShell } from "~/components/site-shell";
import { pageMeta } from "~/meta";
import {
  CATEGORIES,
  type CategorySlug,
  getCategory,
  getRegistry,
  getPluginsInCategory,
  type Plugin,
  type PluginSort,
  queryPlugins,
  sortPlugins,
} from "~/plugins";
import { CategoryLink } from "~/plugins/category-link";
import { PLUGIN_GRID_CLASS, PluginCard } from "~/plugins/plugin-card";
import { PluginsTrustNote } from "~/plugins/plugin-page-header";
import "~/styles.css";

interface PluginsSearch {
  category?: CategorySlug;
  q?: string;
  sort?: PluginSort;
}

const SECTION_PREVIEW_COUNT = 3;

export const Route = createFileRoute("/plugins/")({
  validateSearch: (search: Record<string, unknown>): PluginsSearch => {
    const result: PluginsSearch = {};
    const category = typeof search.category === "string" ? getCategory(search.category) : null;
    if (category) result.category = category.slug;
    if (typeof search.q === "string" && search.q.trim()) result.q = search.q;
    if (search.sort === "new") result.sort = "new";
    return result;
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

const PILL_BASE =
  "inline-flex flex-shrink-0 items-center rounded-full border px-3 py-1.5 text-xs transition-colors";
const PILL_ACTIVE = `${PILL_BASE} border-white/20 bg-white/[0.07] text-white`;
const PILL_INACTIVE = `${PILL_BASE} border-white/10 bg-white/[0.025] text-muted-foreground hover:border-white/15 hover:bg-white/[0.04] hover:text-foreground`;
const VIEW_ALL_CLASS =
  "flex-shrink-0 text-xs text-extra-muted-foreground transition-colors hover:text-muted-foreground";

function PluginsPage() {
  const search = Route.useSearch();
  const { plugins } = Route.useLoaderData();
  const navigate = useNavigate({ from: "/plugins/" });
  const sort: PluginSort = search.sort ?? "popular";
  const filtering = Boolean(search.category || search.q);

  const handleSearchChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const q = event.target.value;
      void navigate({
        search: (prev) => (q ? { ...prev, q } : { ...prev, q: undefined }),
        replace: true,
      });
    },
    [navigate],
  );
  const handleSort = useCallback(
    (next: PluginSort) => {
      void navigate({
        search: (prev) => ({ ...prev, sort: next === "new" ? next : undefined }),
        replace: true,
      });
    },
    [navigate],
  );

  return (
    <SiteShell width="default">
      <h1 className="text-3xl font-medium tracking-tight mb-4">Plugins</h1>
      <p className="text-lg text-white/70 leading-relaxed max-w-2xl">
        Themes, providers, panels, and automations built by the Paseo community. Install any of them
        with one command.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
        <PluginsTrustNote />
        <a
          href="/docs/plugins"
          className="text-xs text-extra-muted-foreground transition-colors hover:text-muted-foreground"
        >
          Build your own
        </a>
      </div>

      <div className="mt-12 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <label className="relative flex-1 md:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-extra-muted-foreground" />
          <input
            type="search"
            value={search.q ?? ""}
            onChange={handleSearchChange}
            placeholder="Search plugins"
            aria-label="Search plugins"
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-extra-muted-foreground focus:border-white/20 focus:outline-none"
          />
        </label>
        <div role="group" aria-label="Sort" className="flex items-center gap-2">
          <SortButton value="popular" current={sort} onSelect={handleSort}>
            Popular
          </SortButton>
          <SortButton value="new" current={sort} onSelect={handleSort}>
            New
          </SortButton>
        </div>
      </div>

      <div className="-mx-6 mt-4 flex gap-2 overflow-x-auto px-6 pb-1 md:mx-0 md:flex-wrap md:px-0">
        <CategoryLink
          category={null}
          q={search.q}
          sort={sort}
          replace
          className={search.category ? PILL_INACTIVE : PILL_ACTIVE}
        >
          All
        </CategoryLink>
        {CATEGORIES.map((category) => {
          if (getPluginsInCategory(plugins, category.slug).length === 0) return null;
          return (
            <CategoryLink
              key={category.slug}
              category={category.slug}
              q={search.q}
              sort={sort}
              replace
              className={search.category === category.slug ? PILL_ACTIVE : PILL_INACTIVE}
            >
              {category.label}
            </CategoryLink>
          );
        })}
      </div>

      {filtering ? (
        <FilteredPlugins search={search} sort={sort} plugins={plugins} />
      ) : (
        <CategorySections sort={sort} plugins={plugins} />
      )}
    </SiteShell>
  );
}

function SortButton({
  value,
  current,
  onSelect,
  children,
}: {
  value: PluginSort;
  current: PluginSort;
  onSelect: (sort: PluginSort) => void;
  children: string;
}) {
  const handleClick = useCallback(() => onSelect(value), [onSelect, value]);
  const active = value === current;
  return (
    <button
      type="button"
      onClick={handleClick}
      aria-pressed={active}
      className={active ? PILL_ACTIVE : PILL_INACTIVE}
    >
      {children}
    </button>
  );
}

function CategorySections({ sort, plugins }: { sort: PluginSort; plugins: Plugin[] }) {
  return (
    <div className="mt-12 space-y-16">
      {CATEGORIES.map((category) => {
        const all = sortPlugins(getPluginsInCategory(plugins, category.slug), sort);
        if (all.length === 0) return null;
        const shown = all.slice(0, SECTION_PREVIEW_COUNT);
        return (
          <section key={category.slug} aria-labelledby={`category-${category.slug}`}>
            <div className="mb-6 flex items-end justify-between gap-4">
              <div className="space-y-1">
                <h2 id={`category-${category.slug}`} className="text-xl font-medium">
                  {category.label}
                </h2>
                <p className="text-sm text-muted-foreground">{category.description}</p>
              </div>
              {all.length > shown.length && (
                <CategoryLink category={category.slug} sort={sort} className={VIEW_ALL_CLASS}>
                  View all ({all.length})
                </CategoryLink>
              )}
            </div>
            <div className={PLUGIN_GRID_CLASS}>
              {shown.map((plugin) => (
                <PluginCard key={plugin.id} plugin={plugin} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function FilteredPlugins({
  search,
  sort,
  plugins,
}: {
  search: PluginsSearch;
  sort: PluginSort;
  plugins: Plugin[];
}) {
  const category = search.category ? getCategory(search.category) : null;
  const results = queryPlugins(plugins, { category: search.category, q: search.q, sort });
  const total = plugins.length;

  return (
    <section className="mt-12" aria-live="polite">
      <div className="mb-6 space-y-1">
        <h2 className="text-xl font-medium">
          {category ? category.label : `Results for “${search.q}”`}
        </h2>
        <p className="text-sm text-muted-foreground">
          {category && !search.q ? category.description : null}
          {search.q && category ? `Matching “${search.q}”.` : null}
          {!category && search.q ? `${results.length} of ${total} plugins.` : null}
        </p>
      </div>
      {results.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-10 text-center">
          <p className="text-sm text-muted-foreground">No plugins match.</p>
          <CategoryLink
            category={null}
            className="mt-2 inline-block text-xs text-extra-muted-foreground transition-colors hover:text-muted-foreground"
          >
            Clear filters
          </CategoryLink>
        </div>
      ) : (
        <div className={PLUGIN_GRID_CLASS}>
          {results.map((plugin) => (
            <PluginCard key={plugin.id} plugin={plugin} />
          ))}
        </div>
      )}
    </section>
  );
}
