// Direction D — Index. Typographic and quiet, like the changelog: rows in cards, no imagery
// on the directory, numbers aligned in a column.
import { CodeBlock } from "~/components/code-block";
import { formatInstalls, getAuthor, installCommand, pluginVersion } from "~/plugins";
import { AuthorLink } from "~/plugins/author-link";
import {
  addedAgo,
  type Direction,
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
  XS_LINK,
} from "./shared";

const CARD = "rounded-xl border border-white/10 bg-white/[0.02]";
const LABEL = "mb-3 flex items-baseline justify-between text-sm font-medium text-white";
const MORE =
  "text-xs font-normal text-extra-muted-foreground transition-colors hover:text-muted-foreground";

function PluginRow({ plugin, trailing }: { plugin: MockPlugin; trailing: string }) {
  return (
    <a
      href={pluginHref("d", plugin)}
      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03] [&+&]:border-t [&+&]:border-white/[0.06]"
    >
      <PluginTile plugin={plugin} size="sm" />
      <div className="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-3">
        <p className="flex-shrink-0 text-sm text-white">{plugin.name}</p>
        <p className="truncate text-sm text-extra-muted-foreground">{plugin.description}</p>
      </div>
      <span className="flex-shrink-0 text-xs tabular-nums text-extra-muted-foreground">
        {trailing}
      </span>
    </a>
  );
}

function Directory({ plugins }: { plugins: MockPlugin[] }) {
  const newest = sortBy(plugins, "new").slice(0, 5);
  const top = sortBy(plugins, "installs").slice(0, 5);
  return (
    <div className="max-w-3xl">
      <h1 className="text-3xl font-medium tracking-tight">Plugins</h1>
      <p className="mt-2 text-sm text-extra-muted-foreground">
        {plugins.length} community plugins ·{" "}
        <BuildSubmitLinks className="text-muted-foreground underline-offset-4 transition-colors hover:text-foreground [&+&]:before:mx-2 [&+&]:before:text-extra-muted-foreground [&+&]:before:content-['·']" />
      </p>

      <section className="mt-12">
        <h2 className={LABEL}>
          What's new
          <a href={listHref("d", { sort: "new" })} className={MORE}>
            All, newest first
          </a>
        </h2>
        <div className={CARD}>
          {newest.map((plugin) => (
            <PluginRow key={plugin.id} plugin={plugin} trailing={addedAgo(plugin)} />
          ))}
        </div>
      </section>

      <section className="mt-12">
        <h2 className={LABEL}>Categories</h2>
        <div className="grid grid-cols-2 gap-x-8 sm:grid-cols-3">
          {MOCK_CATEGORIES.map((category) => (
            <a
              key={category.slug}
              href={listHref("d", { category: category.slug })}
              className="flex items-baseline justify-between gap-3 border-b border-white/[0.06] py-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {category.label}
              <span className="text-xs tabular-nums text-extra-muted-foreground">
                {inCategory(plugins, category.slug).length}
              </span>
            </a>
          ))}
        </div>
      </section>

      <section className="mt-12">
        <h2 className={LABEL}>
          Most installed
          <a href={listHref("d", { sort: "installs" })} className={MORE}>
            All, by installs
          </a>
        </h2>
        <div className={CARD}>
          {top.map((plugin) => (
            <PluginRow
              key={plugin.id}
              plugin={plugin}
              trailing={formatInstalls(plugin.installs ?? 0)}
            />
          ))}
        </div>
      </section>
    </div>
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
  const effective: MockSort = sort ?? (category ? "installs" : "new");
  const results = sortBy(category ? inCategory(plugins, category.slug) : plugins, effective);
  const other: MockSort = effective === "new" ? "installs" : "new";
  return (
    <div className="max-w-3xl">
      <a href="/plugins-mock/d" className="text-sm text-muted-foreground hover:text-foreground">
        ← Plugins
      </a>
      <h1 className="mt-4 text-3xl font-medium tracking-tight">
        {category?.label ?? "All plugins"}
      </h1>
      <p className="mt-2 text-sm text-extra-muted-foreground">
        {results.length} · {effective === "new" ? "Newest first" : "Most installed first"} ·{" "}
        <a
          href={listHref("d", { category: category?.slug, sort: other })}
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          {other === "new" ? "Sort by newest" : "Sort by installs"}
        </a>
      </p>
      <div className={`${CARD} mt-8`}>
        {results.map((plugin) => (
          <PluginRow
            key={plugin.id}
            plugin={plugin}
            trailing={effective === "new" ? addedAgo(plugin) : formatInstalls(plugin.installs ?? 0)}
          />
        ))}
      </div>
    </div>
  );
}

function Detail({ plugin }: Parameters<DirectionComponents["Detail"]>[0]) {
  return <PluginDetail plugin={plugin} direction="d" />;
}

/** Single-column detail page, shared with the final combination. */
export function PluginDetail({ plugin, direction }: { plugin: DetailPlugin; direction: Direction }) {
  const category = mockCategory(plugin.categories[0]);
  const author = getAuthor(plugin);
  return (
    <div className="max-w-3xl">
      <a href={`/plugins-mock/${direction}`} className="text-sm text-muted-foreground hover:text-foreground">
        ← Plugins
      </a>
      <h1 className="mt-4 text-3xl font-medium tracking-tight">{plugin.name}</h1>
      <p className="mt-3 text-lg leading-relaxed text-white/70">{plugin.description}</p>
      <div className="mt-6">
        <CodeBlock size="sm">{installCommand(plugin)}</CodeBlock>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 text-xs text-extra-muted-foreground [&>*+*]:before:mr-2 [&>*+*]:before:content-['·']">
        <AuthorLink author={author} className={XS_LINK}>
          {author.name}
        </AuthorLink>
        {category && (
          <a href={listHref(direction, { category: category.slug })} className={XS_LINK}>
            {category.label}
          </a>
        )}
        <span className="tabular-nums">{formatInstalls(plugin.installs ?? 0)} installs</span>
        <span className="font-mono">{pluginVersion(plugin)}</span>
        <SourceLinks plugin={plugin} />
      </div>
      {plugin.screenshots.length > 0 && (
        <div className="mt-10 [&_a]:md:w-[calc(50%-0.375rem)]">
          <Screenshots plugin={plugin} />
        </div>
      )}
      <div className="mt-10 border-t border-white/10 pt-10">
        <Readme plugin={plugin} />
      </div>
    </div>
  );
}

export const directionD: DirectionComponents = { Directory, List, Detail };
