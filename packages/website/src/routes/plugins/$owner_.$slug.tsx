import { createFileRoute, notFound } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { CodeBlock } from "~/components/code-block";
import { PluginOverview, PluginContentLink } from "~/plugins/overview";
import { pluginOverviewUrl } from "@getpaseo/protocol/plugin-overview";
import { SiteShell } from "~/components/site-shell";
import { pageMeta } from "~/meta";
import {
  formatInstalls,
  getAuthor,
  getCategory,
  getRegistry,
  getRegistryPlugin,
  installCommand,
  npmUrl,
  pluginVersion,
  readmeBody,
} from "~/plugins";
import { AuthorLink } from "~/plugins/author-link";
import { categoryHref } from "~/plugins/links";
import { PluginsNotFound } from "~/plugins/not-found";
import "~/styles.css";

export const Route = createFileRoute("/plugins/$owner_/$slug")({
  loader: async ({ params }) => {
    const [registry, plugin] = await Promise.all([
      getRegistry(),
      getRegistryPlugin({ data: `${params.owner}/${params.slug}` }),
    ]);
    if (!plugin) throw notFound();
    return { plugin, installs: registry.installs[plugin.id]?.all ?? 0 };
  },
  head: ({ params, loaderData }) =>
    pageMeta(
      loaderData?.plugin ? `${loaderData.plugin.name} – Paseo plugin` : "Plugin not found – Paseo",
      loaderData?.plugin?.description ?? "Plugin not found.",
      `/plugins/${params.owner}/${params.slug}`,
      loaderData?.plugin.screenshots.find(pluginOverviewUrl),
    ),
  component: PluginPage,
  notFoundComponent: () => (
    <PluginsNotFound title="Plugin not found">
      There is no plugin listed at this address.
    </PluginsNotFound>
  ),
});

const META_LINK_CLASS =
  "inline-flex items-center gap-1 text-xs text-extra-muted-foreground transition-colors hover:text-muted-foreground";

function PluginPage() {
  const { plugin, installs } = Route.useLoaderData();
  const category = getCategory(plugin.categories[0]);
  const author = getAuthor(plugin);
  const npm = npmUrl(plugin);

  return (
    <SiteShell width="default">
      <div className="max-w-3xl">
        <a href="/plugins" className="text-sm text-muted-foreground hover:text-foreground">
          ← Plugins
        </a>
        <h1 className="mt-4 text-3xl font-medium tracking-tight">{plugin.name}</h1>
        <p className="mt-3 text-lg leading-relaxed text-white/70">{plugin.description}</p>
        <div className="mt-6">
          <CodeBlock size="sm">{installCommand(plugin)}</CodeBlock>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 text-xs text-extra-muted-foreground [&>*+*]:before:mr-2 [&>*+*]:before:content-['·'_/_'']">
          <AuthorLink author={author} className={META_LINK_CLASS}>
            {author.name}
          </AuthorLink>
          {category && (
            <a href={categoryHref(category.slug)} className={META_LINK_CLASS}>
              {category.label}
            </a>
          )}
          <span className="tabular-nums">{formatInstalls(installs)} installs</span>
          <span className="font-mono">{pluginVersion(plugin)}</span>
          <PluginContentLink href={plugin.repository.url} className={META_LINK_CLASS}>
            Source
            <ExternalLink className="h-3 w-3" />
          </PluginContentLink>
          {npm && (
            <PluginContentLink href={npm} className={META_LINK_CLASS}>
              npm
              <ExternalLink className="h-3 w-3" />
            </PluginContentLink>
          )}
        </div>

        {plugin.screenshots.length > 0 && (
          <div className="-mx-6 mt-10 flex gap-3 overflow-x-auto px-6 md:mx-0 md:px-0">
            {plugin.screenshots.map((url, index) =>
              pluginOverviewUrl(url) ? (
                <PluginContentLink
                  key={url}
                  href={url}
                  className="aspect-video w-[85%] flex-shrink-0 overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] sm:w-[60%] md:w-[calc(50%-0.375rem)]"
                >
                  <img
                    src={url}
                    alt={`${plugin.name} screenshot ${index + 1}`}
                    loading="lazy"
                    className="h-full w-full object-cover object-top"
                  />
                </PluginContentLink>
              ) : (
                <p key={url}>{url}</p>
              ),
            )}
          </div>
        )}

        <div className="mt-10 border-t border-white/10 pt-10">
          <PluginOverview>{readmeBody(plugin.readme)}</PluginOverview>
        </div>
      </div>
    </SiteShell>
  );
}
