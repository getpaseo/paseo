// Direction A — Shelves. A storefront: visual "What's new" shelf, category tiles, a ranked list.
import { ChevronRight, Download } from "lucide-react";
import { type BreadcrumbItem, Breadcrumbs } from "~/components/breadcrumbs";
import { CodeBlock } from "~/components/code-block";
import { formatInstalls, getAuthor, installCommand, pluginVersion } from "~/plugins";
import { AuthorLink } from "~/plugins/author-link";
import {
  addedAgo,
  inCategory,
  listHref,
  MOCK_CATEGORIES,
  type MockPlugin,
  type MockSort,
  mockCategory,
  pluginHref,
  sortBy,
} from "./data";
import {
  BuildSubmitLinks,
  type DirectionComponents,
  PluginTile,
  Readme,
  Screenshots,
  Shot,
  SourceLinks,
} from "./shared";

const SEE_ALL =
  "inline-flex items-center gap-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground";

function SectionHeader({ title, href }: { title: string; href?: string }) {
  return (
    <div className="mb-4 flex items-baseline justify-between gap-4">
      <h2 className="text-lg font-medium">{title}</h2>
      {href && (
        <a href={href} className={SEE_ALL}>
          See all
          <ChevronRight className="h-3.5 w-3.5" />
        </a>
      )}
    </div>
  );
}

function ShelfCard({ plugin, meta }: { plugin: MockPlugin; meta: string }) {
  return (
    <a href={pluginHref("a", plugin)} className="group block w-[70%] flex-shrink-0 sm:w-auto">
      <Shot
        plugin={plugin}
        className="aspect-[16/10] rounded-xl transition-colors group-hover:border-white/20"
      />
      <div className="mt-3 flex items-center gap-2.5">
        <PluginTile plugin={plugin} size="sm" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white">{plugin.name}</p>
          <p className="truncate text-xs text-extra-muted-foreground">{meta}</p>
        </div>
      </div>
    </a>
  );
}

function RankRow({ plugin, rank }: { plugin: MockPlugin; rank: number }) {
  const category = mockCategory(plugin.categories[0]);
  return (
    <a
      href={pluginHref("a", plugin)}
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
      <span className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
        <Download className="h-3 w-3" />
        {formatInstalls(plugin.installs ?? 0)}
      </span>
    </a>
  );
}

function Directory({ plugins }: { plugins: MockPlugin[] }) {
  const newest = sortBy(plugins, "new").slice(0, 4);
  const top = sortBy(plugins, "installs").slice(0, 6);
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
        <SectionHeader title="What's new" href={listHref("a", { sort: "new" })} />
        <div className="-mx-6 flex gap-4 overflow-x-auto px-6 pb-1 sm:mx-0 sm:grid sm:grid-cols-2 sm:px-0 lg:grid-cols-4">
          {newest.map((plugin) => (
            <ShelfCard key={plugin.id} plugin={plugin} meta={`Added ${addedAgo(plugin)}`} />
          ))}
        </div>
      </section>

      <section className="mt-14">
        <SectionHeader title="Categories" />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {MOCK_CATEGORIES.map((category) => {
            const Icon = category.icon;
            const count = inCategory(plugins, category.slug).length;
            return (
              <a
                key={category.slug}
                href={listHref("a", { category: category.slug })}
                className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3.5 sm:px-4 transition-colors hover:border-white/20 hover:bg-white/[0.05]"
              >
                <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 text-sm leading-tight text-white">
                  {category.label}
                </span>
                <span className="text-xs tabular-nums text-extra-muted-foreground">{count}</span>
              </a>
            );
          })}
        </div>
      </section>

      <section className="mt-14">
        <SectionHeader title="Most installed" href={listHref("a", { sort: "installs" })} />
        <div className="-mx-2 grid gap-x-8 md:grid-cols-2">
          {top.map((plugin, index) => (
            <RankRow key={plugin.id} plugin={plugin} rank={index + 1} />
          ))}
        </div>
      </section>
    </>
  );
}

const SEG_BASE = "rounded-md px-3 py-1 text-xs transition-colors";
const SEG_ON = `${SEG_BASE} bg-white/[0.08] text-white`;
const SEG_OFF = `${SEG_BASE} text-muted-foreground hover:text-foreground`;

function List({
  plugins,
  category: categorySlug,
  sort,
}: {
  plugins: MockPlugin[];
  category?: string;
  sort?: MockSort;
}) {
  const category = categorySlug ? mockCategory(categorySlug) : null;
  const effectiveSort: MockSort = sort ?? (category ? "installs" : "new");
  const scoped = category ? inCategory(plugins, category.slug) : plugins;
  const results = sortBy(scoped, effectiveSort);
  const title = category
    ? category.label
    : effectiveSort === "new"
      ? "Newest plugins"
      : "Most installed";
  return (
    <>
      <Breadcrumbs items={[{ label: "Plugins", href: "/plugins-mock/a" }, { label: title }]} />
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-3xl font-medium tracking-tight">
          {title}
          <span className="ml-3 align-middle text-sm font-normal text-extra-muted-foreground tabular-nums">
            {results.length}
          </span>
        </h1>
        <div className="flex gap-1 rounded-lg border border-white/10 p-0.5">
          <a
            href={listHref("a", { category: category?.slug, sort: "new" })}
            className={effectiveSort === "new" ? SEG_ON : SEG_OFF}
          >
            Newest
          </a>
          <a
            href={listHref("a", { category: category?.slug, sort: "installs" })}
            className={effectiveSort === "installs" ? SEG_ON : SEG_OFF}
          >
            Most installed
          </a>
        </div>
      </div>
      <div className="mt-8 grid gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
        {results.map((plugin) => (
          <ShelfCard
            key={plugin.id}
            plugin={plugin}
            meta={
              effectiveSort === "new"
                ? `Added ${addedAgo(plugin)}`
                : `${formatInstalls(plugin.installs ?? 0)} installs`
            }
          />
        ))}
      </div>
    </>
  );
}

function Detail({ plugin }: Parameters<DirectionComponents["Detail"]>[0]) {
  const category = mockCategory(plugin.categories[0]);
  const author = getAuthor(plugin);
  const crumbs: BreadcrumbItem[] = [
    { label: "Plugins", href: "/plugins-mock/a" },
    ...(category
      ? [{ label: category.label, href: listHref("a", { category: category.slug }) }]
      : []),
    { label: plugin.name },
  ];
  return (
    <>
      <Breadcrumbs items={crumbs} />
      <div className="flex items-start gap-4">
        <PluginTile plugin={plugin} size="lg" />
        <div className="min-w-0 space-y-1">
          <h1 className="text-3xl font-medium tracking-tight">{plugin.name}</h1>
          <AuthorLink author={author} />
        </div>
      </div>
      <p className="mt-5 max-w-2xl text-lg leading-relaxed text-white/70">{plugin.description}</p>
      <div className="mt-6 max-w-xl">
        <CodeBlock size="sm">{installCommand(plugin)}</CodeBlock>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-extra-muted-foreground">
        {category && (
          <a
            href={listHref("a", { category: category.slug })}
            className="hover:text-muted-foreground"
          >
            {category.label}
          </a>
        )}
        <span className="tabular-nums">{formatInstalls(plugin.installs ?? 0)} installs</span>
        <span className="font-mono">{pluginVersion(plugin)}</span>
        <SourceLinks plugin={plugin} />
      </div>
      {plugin.screenshots.length > 0 && (
        <div className="mt-10">
          <Screenshots plugin={plugin} />
        </div>
      )}
      <div className="mt-12 max-w-3xl">
        <Readme plugin={plugin} />
      </div>
    </>
  );
}

export const directionA: DirectionComponents = { Directory, List, Detail };
