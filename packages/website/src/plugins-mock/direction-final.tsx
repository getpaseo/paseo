// Final combination. Directory: A's shelves with a time window on Most installed.
// Browse pages: B's category rail with a list of screenshot cards. Detail: D's single column.
import { ChevronRight, Download } from "lucide-react";
import type { ReactNode } from "react";
import { formatInstalls } from "~/plugins";
import {
  addedAgo,
  inCategory,
  listHref,
  MOCK_CATEGORIES,
  MOCK_WINDOWS,
  type MockPlugin,
  type MockSort,
  type MockWindow,
  mockCategory,
  pluginHref,
  sortBy,
  sortByInstalls,
} from "./data";
import { PluginDetail } from "./direction-d";
import { BuildSubmitLinks, type DirectionComponents, PluginTile, Shot } from "./shared";

const HOME = "/plugins-mock/final";

const SEE_ALL =
  "inline-flex items-center gap-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground";

/** Plain text time-window switch. The caller decides where each option links. */
function WindowSwitch({
  current,
  hrefFor,
}: {
  current: MockWindow;
  hrefFor: (window: MockWindow) => string;
}) {
  return (
    <nav aria-label="Time window" className="flex items-baseline gap-4 text-sm">
      {MOCK_WINDOWS.map((option) => (
        <a
          key={option.value}
          href={hrefFor(option.value)}
          aria-current={option.value === current ? "true" : undefined}
          className={
            option.value === current
              ? "text-foreground"
              : "text-extra-muted-foreground transition-colors hover:text-muted-foreground"
          }
        >
          {option.label}
        </a>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------------------------
// Directory

function ShelfCard({ plugin }: { plugin: MockPlugin }) {
  return (
    <a href={pluginHref("final", plugin)} className="group block w-[70%] flex-shrink-0 sm:w-auto">
      <Shot
        plugin={plugin}
        className="aspect-[16/10] rounded-xl transition-colors group-hover:border-white/20"
      />
      <div className="mt-3 flex items-center gap-2.5">
        <PluginTile plugin={plugin} size="sm" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white">{plugin.name}</p>
          <p className="truncate text-xs text-extra-muted-foreground">Added {addedAgo(plugin)}</p>
        </div>
      </div>
    </a>
  );
}

function RankRow({
  plugin,
  rank,
  window,
}: {
  plugin: MockPlugin;
  rank: number;
  window: MockWindow;
}) {
  const category = mockCategory(plugin.categories[0]);
  return (
    <a
      href={pluginHref("final", plugin)}
      className="flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-white/[0.04]"
    >
      <span className="w-4 text-right text-sm tabular-nums text-extra-muted-foreground">
        {rank}
      </span>
      <PluginTile plugin={plugin} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-white">{plugin.name}</p>
        <p className="truncate text-xs text-extra-muted-foreground">{category?.label}</p>
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">
        {formatInstalls(plugin.installsIn[window])}
      </span>
    </a>
  );
}

function Directory({ plugins, window = "week" }: { plugins: MockPlugin[]; window?: MockWindow }) {
  const newest = sortBy(plugins, "new").slice(0, 4);
  const top = sortByInstalls(plugins, window).slice(0, 6);
  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-baseline sm:justify-between">
        <h1 className="text-3xl font-medium tracking-tight">
          Plugins
          <span className="ml-3 align-middle text-sm font-normal text-extra-muted-foreground tabular-nums">
            {plugins.length}
          </span>
        </h1>
        <div className="flex gap-5">
          <BuildSubmitLinks />
        </div>
      </div>

      <section className="mt-10">
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <h2 className="text-lg font-medium">What's new</h2>
          <a href={listHref("final", { sort: "new" })} className={SEE_ALL}>
            See all
            <ChevronRight className="h-3.5 w-3.5" />
          </a>
        </div>
        <div className="-mx-6 flex gap-4 overflow-x-auto px-6 pb-1 sm:mx-0 sm:grid sm:grid-cols-2 sm:px-0 lg:grid-cols-4">
          {newest.map((plugin) => (
            <ShelfCard key={plugin.id} plugin={plugin} />
          ))}
        </div>
      </section>

      <section className="mt-14">
        <h2 className="mb-4 text-lg font-medium">Categories</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {MOCK_CATEGORIES.map((category) => {
            const Icon = category.icon;
            return (
              <a
                key={category.slug}
                href={listHref("final", { category: category.slug })}
                className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3.5 transition-colors hover:border-white/20 hover:bg-white/[0.05] sm:px-4"
              >
                <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 text-sm leading-tight text-white">
                  {category.label}
                </span>
                <span className="text-xs tabular-nums text-extra-muted-foreground">
                  {inCategory(plugins, category.slug).length}
                </span>
              </a>
            );
          })}
        </div>
      </section>

      <section id="most-installed" className="mt-14 scroll-mt-8">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <a
            href={listHref("final", { sort: "installs", window })}
            className="group inline-flex items-center gap-1 text-lg font-medium"
          >
            Most installed
            <ChevronRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
          </a>
          <WindowSwitch
            current={window}
            hrefFor={(next) =>
              `${HOME}${next === "week" ? "" : `?window=${next}`}#most-installed`
            }
          />
        </div>
        <div className="-mx-2 grid gap-x-8 md:grid-cols-2">
          {top.map((plugin, index) => (
            <RankRow key={plugin.id} plugin={plugin} rank={index + 1} window={window} />
          ))}
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Browse pages

interface BrowseQuery {
  category?: string;
  sort: MockSort;
  window: MockWindow;
}

const NAV_BASE =
  "flex items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-sm transition-colors";
const NAV_ON = `${NAV_BASE} bg-white/[0.06] text-white`;
const NAV_OFF = `${NAV_BASE} text-muted-foreground hover:text-foreground`;
const CHIP_BASE =
  "inline-flex flex-shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors";
const CHIP_ON = `${CHIP_BASE} border-white/20 bg-white/[0.07] text-white`;
const CHIP_OFF = `${CHIP_BASE} border-white/10 text-muted-foreground`;

function Rail({ plugins, query }: { plugins: MockPlugin[]; query: BrowseQuery }) {
  const entries = [
    { slug: undefined, label: "All plugins", count: plugins.length },
    ...MOCK_CATEGORIES.map((category) => ({
      slug: category.slug as string | undefined,
      label: category.label as string,
      count: inCategory(plugins, category.slug).length,
    })),
  ];
  const hrefFor = (slug: string | undefined) => listHref("final", { ...query, category: slug });
  return (
    <>
      <nav aria-label="Categories" className="-ml-2.5 hidden w-48 flex-shrink-0 lg:block">
        {entries.map((entry, index) => (
          <div key={entry.label}>
            <a href={hrefFor(entry.slug)} className={query.category === entry.slug ? NAV_ON : NAV_OFF}>
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
          <BuildSubmitLinks className="text-sm text-extra-muted-foreground transition-colors hover:text-muted-foreground" />
        </div>
      </nav>
      <div className="-mx-6 mb-8 flex gap-2 overflow-x-auto px-6 pb-1 lg:hidden">
        {entries.map((entry) => (
          <a
            key={entry.label}
            href={hrefFor(entry.slug)}
            className={query.category === entry.slug ? CHIP_ON : CHIP_OFF}
          >
            {entry.slug ? entry.label : "All"}
          </a>
        ))}
      </div>
    </>
  );
}

const TAB_BASE = "-mb-px border-b pb-2 text-sm transition-colors";
const TAB_ON = `${TAB_BASE} border-white text-white`;
const TAB_OFF = `${TAB_BASE} border-transparent text-muted-foreground hover:text-foreground`;

function SortBar({ query }: { query: BrowseQuery }) {
  const windowSwitch = query.sort === "installs" && (
    <WindowSwitch
      current={query.window}
      hrefFor={(window) => listHref("final", { ...query, window })}
    />
  );
  return (
    <>
      <div className="flex items-baseline justify-between gap-6 border-b border-white/10">
        <div className="flex gap-6">
          <a
            href={listHref("final", { ...query, sort: "installs" })}
            className={query.sort === "installs" ? TAB_ON : TAB_OFF}
          >
            Most installed
          </a>
          <a
            href={listHref("final", { ...query, sort: "new" })}
            className={query.sort === "new" ? TAB_ON : TAB_OFF}
          >
            Newest
          </a>
        </div>
        {windowSwitch && <div className="hidden pb-2 sm:block">{windowSwitch}</div>}
      </div>
      {windowSwitch && <div className="mt-4 sm:hidden">{windowSwitch}</div>}
    </>
  );
}

/** The What's new card from the directory, plus a clamped description. */
function GridCard({ plugin, meta }: { plugin: MockPlugin; meta: ReactNode }) {
  return (
    <a href={pluginHref("final", plugin)} className="group block">
      <Shot
        plugin={plugin}
        className="aspect-[16/10] rounded-xl transition-colors group-hover:border-white/20"
      />
      <div className="mt-3 flex items-start gap-2.5">
        <PluginTile plugin={plugin} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="truncate text-sm font-medium text-white">{plugin.name}</p>
            <span className="inline-flex flex-shrink-0 items-center gap-1 text-xs tabular-nums text-extra-muted-foreground">
              {meta}
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

function List({
  plugins,
  category: slug,
  sort = "installs",
  window = "week",
}: {
  plugins: MockPlugin[];
  category?: string;
  sort?: MockSort;
  window?: MockWindow;
}) {
  const category = slug ? mockCategory(slug) : null;
  const query: BrowseQuery = { category: category?.slug, sort, window };
  const scoped = category ? inCategory(plugins, category.slug) : plugins;
  const results = sort === "new" ? sortBy(scoped, "new") : sortByInstalls(scoped, window);
  return (
    <div className="lg:flex lg:gap-12">
      <Rail plugins={plugins} query={query} />
      <div className="min-w-0 flex-1">
        <h1 className="mb-6 text-3xl font-medium tracking-tight">
          {category?.label ?? "All plugins"}
          <span className="ml-3 align-middle text-sm font-normal tabular-nums text-extra-muted-foreground">
            {scoped.length}
          </span>
        </h1>
        <SortBar query={query} />
        <div className="mt-8 grid gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {results.map((plugin) => (
            <GridCard
              key={plugin.id}
              plugin={plugin}
              meta={
                sort === "new" ? (
                  addedAgo(plugin)
                ) : (
                  <>
                    <Download className="h-3 w-3" />
                    {formatInstalls(plugin.installsIn[window])}
                  </>
                )
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Detail({ plugin }: Parameters<DirectionComponents["Detail"]>[0]): ReactNode {
  return <PluginDetail plugin={plugin} direction="final" />;
}

export const directionFinal: DirectionComponents = { Directory, List, Detail };
