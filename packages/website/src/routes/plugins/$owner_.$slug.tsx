import { createFileRoute, notFound } from "@tanstack/react-router";
import { Download, ExternalLink } from "lucide-react";
import { useMemo } from "react";
import { type BreadcrumbItem, Breadcrumbs } from "~/components/breadcrumbs";
import { CodeBlock } from "~/components/code-block";
import { DocsMarkdown } from "~/components/docs-markdown";
import { SiteShell } from "~/components/site-shell";
import { pageMeta } from "~/meta";
import {
  formatInstalls,
  getAuthor,
  getCategory,
  getRegistry,
  getRegistryPlugin,
  pinnedInstallCommand,
  pluginVersion,
  getPluginsByAuthor,
  getPluginsInCategory,
  installCommand,
  npmUrl,
  type Plugin,
  sortPlugins,
} from "~/plugins";
import { AuthorLink } from "~/plugins/author-link";
import { CategoryLink } from "~/plugins/category-link";
import { PluginsNotFound } from "~/plugins/not-found";
import { PLUGIN_GRID_CLASS, PluginCard } from "~/plugins/plugin-card";
import { PluginsTrustNote } from "~/plugins/plugin-page-header";
import { PluginTile } from "~/plugins/plugin-tile";
import "~/styles.css";

const RELATED_COUNT = 3;

export const Route = createFileRoute("/plugins/$owner_/$slug")({
  loader: async ({ params }) => {
    const [registry, plugin] = await Promise.all([
      getRegistry(),
      getRegistryPlugin({ data: `${params.owner}/${params.slug}` }),
    ]);
    if (!plugin) throw notFound();
    return { plugins: registry.plugins, plugin };
  },
  head: ({ params, loaderData }) =>
    pageMeta(
      loaderData?.plugin ? `${loaderData.plugin.name} – Paseo plugin` : "Plugin not found – Paseo",
      loaderData?.plugin?.description ?? "Plugin not found.",
      `/plugins/${params.owner}/${params.slug}`,
      loaderData?.plugin.screenshots[0],
    ),
  component: PluginPage,
  notFoundComponent: () => (
    <PluginsNotFound title="Plugin not found">
      There is no plugin listed at this address.
    </PluginsNotFound>
  ),
});

const LINK_CLASS =
  "inline-flex items-center gap-1 text-xs text-extra-muted-foreground transition-colors hover:text-muted-foreground";
const VIEW_ALL_CLASS =
  "flex-shrink-0 text-xs text-extra-muted-foreground transition-colors hover:text-muted-foreground";
const CATEGORY_PILL_CLASS =
  "rounded-full border border-white/10 px-2 py-1 text-xs text-white/40 transition-colors hover:border-white/20 hover:text-white/70";

function PluginPage() {
  const { plugins, plugin } = Route.useLoaderData();
  const primaryCategory = getCategory(plugin.categories[0]);

  const crumbs = useMemo<BreadcrumbItem[]>(() => {
    return [
      { label: "Plugins", href: "/plugins" },
      ...(primaryCategory
        ? [{ label: primaryCategory.label, href: `/plugins?category=${primaryCategory.slug}` }]
        : []),
      { label: plugin.name },
    ];
  }, [plugin, primaryCategory]);

  const author = getAuthor(plugin.author);
  const count = plugin.installs;
  const readme = plugin.readme;

  return (
    <SiteShell width="default">
      <Breadcrumbs items={crumbs} />

      <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <PluginTile plugin={plugin} size="lg" />
          <div className="min-w-0 space-y-2">
            <h1 className="text-3xl font-medium tracking-tight">{plugin.name}</h1>
            <p className="text-lg text-white/70 leading-relaxed max-w-2xl">{plugin.description}</p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
              {author && <AuthorLink author={author} />}
              {count !== undefined && (
                <span className="inline-flex items-center gap-1 text-sm text-muted-foreground tabular-nums">
                  <Download className="h-3.5 w-3.5" />
                  {formatInstalls(count)}
                  <span className="text-extra-muted-foreground">installs</span>
                </span>
              )}
              {plugin.categories.map((slug) => {
                const category = getCategory(slug);
                if (!category) return null;
                return (
                  <CategoryLink key={slug} category={category.slug} className={CATEGORY_PILL_CLASS}>
                    {category.label}
                  </CategoryLink>
                );
              })}
            </div>
          </div>
        </div>
        <div className="w-full space-y-2 lg:w-[30rem] lg:flex-shrink-0">
          <CodeBlock size="sm">{installCommand(plugin)}</CodeBlock>
          <p className="text-xs text-muted-foreground">
            {pluginVersion(plugin)} · Updated {plugin.updatedAt.slice(0, 10)}
          </p>
          <p className="text-xs text-muted-foreground">For older daemons</p>
          <CodeBlock size="sm">{pinnedInstallCommand(plugin)}</CodeBlock>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <PluginsTrustNote />
            <div className="flex items-center gap-4">
              <a
                href={plugin.repository.url}
                target="_blank"
                rel="noopener noreferrer"
                className={LINK_CLASS}
              >
                Source
                <ExternalLink className="h-3 w-3" />
              </a>
              {npmUrl(plugin) && (
                <a
                  href={npmUrl(plugin)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={LINK_CLASS}
                >
                  npm
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          </div>
        </div>
      </div>

      {plugin.screenshots.length > 0 && (
        <div className="-mx-6 mt-12 flex gap-3 overflow-x-auto px-6 md:mx-0 md:px-0">
          {plugin.screenshots.map((url, index) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="aspect-video w-[85%] flex-shrink-0 overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] sm:w-[60%] lg:w-[calc(50%-0.375rem)]"
            >
              <img
                src={url}
                alt={`${plugin.name} screenshot ${index + 1}`}
                loading="lazy"
                className="h-full w-full object-cover object-top"
              />
            </a>
          ))}
        </div>
      )}

      <div className="mt-12 max-w-3xl">
        <DocsMarkdown>{readme}</DocsMarkdown>
      </div>

      <RelatedPlugins plugin={plugin} plugins={plugins} />
    </SiteShell>
  );
}

function RelatedPlugins({ plugin, plugins }: { plugin: Plugin; plugins: Plugin[] }) {
  const category = getCategory(plugin.categories[0]);
  const author = getAuthor(plugin.author);
  const inCategory = category
    ? sortPlugins(
        getPluginsInCategory(plugins, category.slug).filter(
          (candidate) => candidate.id !== plugin.id,
        ),
        "popular",
      ).slice(0, RELATED_COUNT)
    : [];
  const byAuthor = author
    ? sortPlugins(
        getPluginsByAuthor(plugins, author.username).filter(
          (candidate) => candidate.id !== plugin.id && !inCategory.includes(candidate),
        ),
        "popular",
      ).slice(0, RELATED_COUNT)
    : [];

  if (inCategory.length === 0 && byAuthor.length === 0) return null;

  return (
    <div className="mt-20 space-y-16">
      {category && inCategory.length > 0 && (
        <section>
          <div className="mb-6 flex items-end justify-between gap-4">
            <h2 className="text-xl font-medium">More in {category.label}</h2>
            <CategoryLink category={category.slug} className={VIEW_ALL_CLASS}>
              View all
            </CategoryLink>
          </div>
          <div className={PLUGIN_GRID_CLASS}>
            {inCategory.map((candidate) => (
              <PluginCard key={candidate.id} plugin={candidate} />
            ))}
          </div>
        </section>
      )}
      {author && byAuthor.length > 0 && (
        <section>
          <div className="mb-6 flex items-end justify-between gap-4">
            <h2 className="text-xl font-medium">More from {author.name}</h2>
            <AuthorLink author={author} className={VIEW_ALL_CLASS}>
              View all
            </AuthorLink>
          </div>
          <div className={PLUGIN_GRID_CLASS}>
            {byAuthor.map((candidate) => (
              <PluginCard key={candidate.id} plugin={candidate} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
