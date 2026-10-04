// Direction C — Gallery. Screenshots carry the page; text is reduced to names.
import { ArrowUpRight, ChevronRight } from "lucide-react";
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
import { BuildSubmitLinks, type DirectionComponents, Readme, Shot, SourceLinks } from "./shared";

const MORE =
  "inline-flex items-center gap-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground";

function ImageCard({
  plugin,
  meta,
  className = "",
}: {
  plugin: MockPlugin;
  meta?: string;
  className?: string;
}) {
  return (
    <a href={pluginHref("c", plugin)} className={`group block ${className}`}>
      <Shot
        plugin={plugin}
        className="aspect-video rounded-xl transition-colors group-hover:border-white/25"
      />
      <div className="mt-2.5 flex items-baseline justify-between gap-3">
        <p className="truncate text-sm text-white">{plugin.name}</p>
        {meta && <p className="flex-shrink-0 text-xs text-extra-muted-foreground">{meta}</p>}
      </div>
    </a>
  );
}

function Directory({ plugins }: { plugins: MockPlugin[] }) {
  const [featured, ...recent] = sortBy(plugins, "new").slice(0, 5);
  const top = sortBy(plugins, "installs").slice(0, 8);
  return (
    <>
      <div className="mb-8 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-3xl font-medium tracking-tight">Plugins</h1>
        <div className="flex gap-5 text-sm">
          <BuildSubmitLinks />
        </div>
      </div>

      <section aria-label="What's new">
        <p className="mb-3 text-xs font-medium uppercase tracking-wider text-extra-muted-foreground">
          What's new
        </p>
        <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
          <a href={pluginHref("c", featured)} className="group relative block">
            <Shot
              plugin={featured}
              className="aspect-video rounded-2xl transition-colors group-hover:border-white/25"
            />
            <div className="absolute inset-x-0 bottom-0 rounded-b-2xl bg-gradient-to-t from-black/85 via-black/50 to-transparent p-5 pt-16">
              <p className="text-xl font-medium text-white">{featured.name}</p>
              <p className="mt-1 line-clamp-1 text-sm text-white/70">{featured.description}</p>
            </div>
          </a>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-1 md:grid-rows-2">
            {recent.slice(0, 2).map((plugin) => (
              <ImageCard key={plugin.id} plugin={plugin} meta={addedAgo(plugin)} />
            ))}
          </div>
        </div>
        <a href={listHref("c", { sort: "new" })} className={`${MORE} mt-4`}>
          All new plugins
          <ChevronRight className="h-3.5 w-3.5" />
        </a>
      </section>

      <section className="mt-16">
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Most installed</h2>
          <a href={listHref("c", { sort: "installs" })} className={MORE}>
            See all
            <ChevronRight className="h-3.5 w-3.5" />
          </a>
        </div>
        <div className="-mx-6 flex gap-4 overflow-x-auto px-6 pb-2 md:mx-0 md:px-0">
          {top.map((plugin) => (
            <ImageCard
              key={plugin.id}
              plugin={plugin}
              meta={formatInstalls(plugin.installs ?? 0)}
              className="w-[60%] flex-shrink-0 sm:w-[38%] md:w-[calc(25%-0.75rem)]"
            />
          ))}
        </div>
      </section>

      <section className="mt-16">
        <h2 className="mb-4 text-lg font-medium">
          Categories
          <span className="ml-2 text-sm font-normal tabular-nums text-extra-muted-foreground">
            {plugins.length} plugins
          </span>
        </h2>
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 md:grid-cols-3">
          {MOCK_CATEGORIES.map((category) => {
            const members = sortBy(inCategory(plugins, category.slug), "installs");
            const covers = members.filter((plugin) => plugin.screenshots.length > 0).slice(0, 2);
            return (
              <a
                key={category.slug}
                href={listHref("c", { category: category.slug })}
                className="group block"
              >
                <div className="relative aspect-[16/10] overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] transition-colors group-hover:border-white/25">
                  {covers[1] && (
                    <img
                      src={covers[1].screenshots[0]}
                      alt=""
                      loading="lazy"
                      className="absolute right-0 top-0 h-[78%] w-[78%] rounded-bl-lg object-cover object-left-top opacity-60"
                    />
                  )}
                  {covers[0] ? (
                    <img
                      src={covers[0].screenshots[0]}
                      alt=""
                      loading="lazy"
                      className="absolute bottom-0 left-0 h-[78%] w-[78%] rounded-tr-lg border-r border-t border-white/10 object-cover object-left-top"
                    />
                  ) : (
                    <category.icon className="absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 text-white/25" />
                  )}
                </div>
                <div className="mt-2.5 flex items-baseline justify-between gap-2">
                  <p className="truncate text-sm text-white">{category.label}</p>
                  <p className="text-xs tabular-nums text-extra-muted-foreground">
                    {members.length}
                  </p>
                </div>
              </a>
            );
          })}
        </div>
      </section>
    </>
  );
}

const PILL = "rounded-full px-3 py-1.5 text-xs transition-colors";

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
  return (
    <>
      <a href="/plugins-mock/c" className="text-sm text-muted-foreground hover:text-foreground">
        Plugins
      </a>
      <div className="mt-2 mb-8 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-medium tracking-tight">
          {category?.label ?? (effective === "new" ? "New plugins" : "Most installed")}
        </h1>
        <div className="flex gap-1">
          {(["new", "installs"] as const).map((value) => (
            <a
              key={value}
              href={listHref("c", { category: category?.slug, sort: value })}
              className={`${PILL} ${effective === value ? "bg-white/[0.08] text-white" : "text-muted-foreground hover:text-foreground"}`}
            >
              {value === "new" ? "Newest" : "Most installed"}
            </a>
          ))}
        </div>
      </div>
      <div className="grid gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
        {results.map((plugin) => (
          <ImageCard
            key={plugin.id}
            plugin={plugin}
            meta={effective === "new" ? addedAgo(plugin) : formatInstalls(plugin.installs ?? 0)}
          />
        ))}
      </div>
    </>
  );
}

function Detail({ plugin }: Parameters<DirectionComponents["Detail"]>[0]) {
  const category = mockCategory(plugin.categories[0]);
  const author = getAuthor(plugin);
  const [hero, ...rest] = plugin.screenshots;
  return (
    <>
      <div className="mb-6 flex items-center gap-2 text-sm text-muted-foreground">
        <a href="/plugins-mock/c" className="hover:text-foreground">
          Plugins
        </a>
        {category && (
          <>
            <ChevronRight className="h-3.5 w-3.5 text-border" />
            <a href={listHref("c", { category: category.slug })} className="hover:text-foreground">
              {category.label}
            </a>
          </>
        )}
      </div>
      {hero && (
        <a href={hero} target="_blank" rel="noopener noreferrer" className="block">
          <img
            src={hero}
            alt={`${plugin.name} screenshot`}
            className="aspect-video w-full rounded-2xl border border-white/10 object-cover object-top"
          />
        </a>
      )}
      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_26rem] lg:items-start">
        <div className="min-w-0">
          <h1 className="text-3xl font-medium tracking-tight">{plugin.name}</h1>
          <p className="mt-3 text-lg leading-relaxed text-white/70">{plugin.description}</p>
        </div>
        <div className="space-y-3">
          <CodeBlock size="sm">{installCommand(plugin)}</CodeBlock>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-extra-muted-foreground">
            <AuthorLink
              author={author}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            />
            <span className="tabular-nums">{formatInstalls(plugin.installs ?? 0)} installs</span>
            <span className="font-mono">{pluginVersion(plugin)}</span>
            <SourceLinks plugin={plugin} />
          </div>
        </div>
      </div>
      {rest.length > 0 && (
        <div className="mt-10 grid grid-cols-2 gap-3 md:grid-cols-3">
          {rest.map((url, index) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="group relative block aspect-video overflow-hidden rounded-xl border border-white/10"
            >
              <img
                src={url}
                alt={`${plugin.name} screenshot ${index + 2}`}
                loading="lazy"
                className="h-full w-full object-cover object-top"
              />
              <ArrowUpRight className="absolute right-2 top-2 h-4 w-4 text-white/0 transition-colors group-hover:text-white/80" />
            </a>
          ))}
        </div>
      )}
      <div className="mt-12 max-w-3xl">
        <Readme plugin={plugin} />
      </div>
    </>
  );
}

export const directionC: DirectionComponents = { Directory, List, Detail };
