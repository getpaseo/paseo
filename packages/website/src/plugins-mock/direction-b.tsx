// Direction B — Catalog. A persistent category rail, like the docs nav. Every view is the same
// page with a different filter, so the directory, a category, and the sorted lists share one layout.
import { Download } from "lucide-react";
import type { ReactNode } from "react";
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
  type DetailPlugin,
  Readme,
  Screenshots,
  SourceLinks,
} from "./shared";

const NAV_BASE =
  "flex items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-sm transition-colors";
const NAV_ON = `${NAV_BASE} bg-white/[0.06] text-white`;
const NAV_OFF = `${NAV_BASE} text-muted-foreground hover:text-foreground`;
const CHIP_BASE =
  "inline-flex flex-shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors";
const CHIP_ON = `${CHIP_BASE} border-white/20 bg-white/[0.07] text-white`;
const CHIP_OFF = `${CHIP_BASE} border-white/10 text-muted-foreground`;

function Rail({ plugins, active }: { plugins: MockPlugin[]; active?: string }) {
  return (
    <>
      <nav aria-label="Categories" className="-ml-2.5 hidden w-48 flex-shrink-0 lg:block">
        <a href="/plugins-mock/b" className={active ? NAV_OFF : NAV_ON}>
          All plugins
          <span className="text-xs tabular-nums text-extra-muted-foreground">{plugins.length}</span>
        </a>
        <div className="my-3 h-px bg-white/10" />
        {MOCK_CATEGORIES.map((category) => (
          <a
            key={category.slug}
            href={listHref("b", { category: category.slug })}
            className={active === category.slug ? NAV_ON : NAV_OFF}
          >
            {category.label}
            <span className="text-xs tabular-nums text-extra-muted-foreground">
              {inCategory(plugins, category.slug).length}
            </span>
          </a>
        ))}
        <div className="my-3 h-px bg-white/10" />
        <div className="flex flex-col gap-1.5 px-2.5">
          <BuildSubmitLinks className="text-sm text-extra-muted-foreground transition-colors hover:text-muted-foreground" />
        </div>
      </nav>
      <div className="-mx-6 mb-8 flex gap-2 overflow-x-auto px-6 pb-1 lg:hidden">
        <a href="/plugins-mock/b" className={active ? CHIP_OFF : CHIP_ON}>
          All
          <span className="tabular-nums text-extra-muted-foreground">{plugins.length}</span>
        </a>
        {MOCK_CATEGORIES.map((category) => (
          <a
            key={category.slug}
            href={listHref("b", { category: category.slug })}
            className={active === category.slug ? CHIP_ON : CHIP_OFF}
          >
            {category.label}
          </a>
        ))}
      </div>
    </>
  );
}

function Layout({
  plugins,
  active,
  children,
}: {
  plugins: MockPlugin[];
  active?: string;
  children: ReactNode;
}) {
  return (
    <div className="lg:flex lg:gap-12">
      <Rail plugins={plugins} active={active} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Row({ plugin, trailing }: { plugin: MockPlugin; trailing: ReactNode }) {
  return (
    <a
      href={pluginHref("b", plugin)}
      className="flex items-center gap-3 py-3 transition-colors hover:bg-white/[0.02]"
    >
      <PluginTile plugin={plugin} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-white">{plugin.name}</p>
        <p className="truncate text-sm text-muted-foreground">{plugin.description}</p>
      </div>
      <span className="flex-shrink-0 text-xs tabular-nums text-extra-muted-foreground">
        {trailing}
      </span>
    </a>
  );
}

const TAB_BASE = "border-b pb-2 text-sm transition-colors";
const TAB_ON = `${TAB_BASE} border-white text-white`;
const TAB_OFF = `${TAB_BASE} border-transparent text-muted-foreground hover:text-foreground`;

function SortedRows({
  plugins,
  category,
  sort,
}: {
  plugins: MockPlugin[];
  category?: string;
  sort: MockSort;
}) {
  return (
    <>
      <div className="flex gap-6 border-b border-white/10">
        <a
          href={listHref("b", { category, sort: "installs" })}
          className={sort === "installs" ? TAB_ON : TAB_OFF}
        >
          Most installed
        </a>
        <a
          href={listHref("b", { category, sort: "new" })}
          className={sort === "new" ? TAB_ON : TAB_OFF}
        >
          Newest
        </a>
      </div>
      <div className="divide-y divide-white/[0.06]">
        {sortBy(plugins, sort).map((plugin) => (
          <Row
            key={plugin.id}
            plugin={plugin}
            trailing={
              sort === "new" ? (
                addedAgo(plugin)
              ) : (
                <span className="inline-flex items-center gap-1">
                  <Download className="h-3 w-3" />
                  {formatInstalls(plugin.installs ?? 0)}
                </span>
              )
            }
          />
        ))}
      </div>
    </>
  );
}

function Directory({ plugins }: { plugins: MockPlugin[] }) {
  const newest = sortBy(plugins, "new").slice(0, 4);
  return (
    <>
      <h1 className="mb-8 text-3xl font-medium tracking-tight">Plugins</h1>
      <Layout plugins={plugins}>
        <h2 className="mb-4 text-lg font-medium">What's new</h2>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {newest.map((plugin) => (
            <a
              key={plugin.id}
              href={pluginHref("b", plugin)}
              className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3.5 transition-colors hover:border-white/20 hover:bg-white/[0.05]"
            >
              <PluginTile plugin={plugin} size="sm" />
              <div className="min-w-0">
                <p className="truncate text-sm text-white">{plugin.name}</p>
                <p className="truncate text-xs text-extra-muted-foreground">{addedAgo(plugin)}</p>
              </div>
            </a>
          ))}
        </div>
        <div className="mt-12">
          <SortedRows plugins={plugins} sort="installs" />
        </div>
        <div className="mt-10 flex gap-5 lg:hidden">
          <BuildSubmitLinks />
        </div>
      </Layout>
    </>
  );
}

function List({
  plugins,
  category: slug,
  sort,
}: {
  plugins: MockPlugin[];
  category?: string;
  sort?: MockSort;
}) {
  const category = slug ? mockCategory(slug) : null;
  const scoped = category ? inCategory(plugins, category.slug) : plugins;
  return (
    <Layout plugins={plugins} active={category?.slug}>
      <h1 className="mb-6 text-lg font-medium">
        {category?.label ?? "All plugins"}
        <span className="ml-2 text-sm font-normal tabular-nums text-extra-muted-foreground">
          {scoped.length}
        </span>
      </h1>
      <SortedRows plugins={scoped} category={category?.slug} sort={sort ?? "installs"} />
    </Layout>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 text-sm">
      <dt className="text-extra-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right text-muted-foreground">{children}</dd>
    </div>
  );
}

function Facts({ plugin }: { plugin: DetailPlugin }) {
  const category = mockCategory(plugin.categories[0]);
  const author = getAuthor(plugin);
  return (
    <>
      <dl className="divide-y divide-white/[0.06]">
        <Fact label="Author">
          <AuthorLink author={author} />
        </Fact>
        {category && (
          <Fact label="Category">
            <a href={listHref("b", { category: category.slug })} className="hover:text-foreground">
              {category.label}
            </a>
          </Fact>
        )}
        <Fact label="Installs">
          <span className="tabular-nums">{formatInstalls(plugin.installs ?? 0)}</span>
        </Fact>
        <Fact label="Version">
          <span className="font-mono text-xs">{pluginVersion(plugin)}</span>
        </Fact>
      </dl>
      <div className="mt-4 flex gap-4">
        <SourceLinks plugin={plugin} />
      </div>
    </>
  );
}

function Detail({ plugin }: Parameters<DirectionComponents["Detail"]>[0]) {
  const category = mockCategory(plugin.categories[0]);
  const author = getAuthor(plugin);
  const crumbs: BreadcrumbItem[] = [
    { label: "Plugins", href: "/plugins-mock/b" },
    ...(category
      ? [{ label: category.label, href: listHref("b", { category: category.slug }) }]
      : []),
    { label: plugin.name },
  ];
  return (
    <>
      <Breadcrumbs items={crumbs} />
      <div className="lg:flex lg:flex-row-reverse lg:gap-12">
        <aside className="hidden lg:block lg:sticky lg:top-8 lg:mb-0 lg:w-60 lg:flex-shrink-0 lg:self-start">
          <Facts plugin={plugin} />
        </aside>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-4">
            <PluginTile plugin={plugin} size="lg" />
            <h1 className="text-3xl font-medium tracking-tight">{plugin.name}</h1>
          </div>
          <p className="mt-4 text-lg leading-relaxed text-white/70">{plugin.description}</p>
          <div className="mt-6">
            <CodeBlock size="sm">{installCommand(plugin)}</CodeBlock>
          </div>
          <div className="mt-6 lg:hidden">
            <Facts plugin={plugin} />
          </div>
          {plugin.screenshots.length > 0 && (
            <div className="mt-8 [&_a]:lg:w-full">
              <Screenshots plugin={plugin} />
            </div>
          )}
          <div className="mt-10">
            <Readme plugin={plugin} />
          </div>
        </div>
      </div>
    </>
  );
}

export const directionB: DirectionComponents = { Directory, List, Detail };
