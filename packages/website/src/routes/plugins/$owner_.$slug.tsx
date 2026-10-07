import { createFileRoute, notFound } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { CodeBlock } from "~/components/code-block";
import { PluginOverview, PluginContentLink } from "~/plugins/overview";
import { SiteShell } from "~/components/site-shell";
import { pageMeta } from "~/meta";
import {
  firstMediaImage,
  getAuthor,
  getCategory,
  getRegistry,
  getRegistryPlugin,
  installCommand,
  npmUrl,
  pluginVersion,
  readmeBody,
} from "~/plugins";
import { AuthorAvatar, AuthorLink } from "~/plugins/author-link";
import { InstallCount } from "~/plugins/install-count";
import { categoryHref } from "~/plugins/links";
import { MediaGallery } from "~/plugins/media-gallery";
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
      loaderData?.plugin && firstMediaImage(loaderData.plugin),
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
const AUTHOR_LINK_CLASS =
  "inline-flex items-center gap-1.5 text-xs text-extra-muted-foreground transition-colors hover:text-muted-foreground";

function PluginPage() {
  const { plugin, installs } = Route.useLoaderData();
  const category = getCategory(plugin.categories[0]);
  const author = getAuthor(plugin);
  const npm = npmUrl(plugin);

  return (
    <SiteShell width="default">
      <a href="/plugins" className="text-sm text-muted-foreground hover:text-foreground">
        ← Plugins
      </a>
      <h1 className="mt-4 text-3xl font-medium tracking-tight">{plugin.name}</h1>
      <p className="mt-3 text-lg leading-relaxed text-white/70">{plugin.description}</p>
      <div className="mt-6 w-fit max-w-full">
        <CodeBlock size="sm">{installCommand(plugin)}</CodeBlock>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 text-xs text-extra-muted-foreground [&>*+*]:before:mr-2 [&>*+*]:before:content-['·'_/_'']">
        <AuthorLink author={author} className={AUTHOR_LINK_CLASS}>
          <AuthorAvatar author={author} size="xs" />
          {author.name}
        </AuthorLink>
        {category && (
          <a href={categoryHref(category.slug)} className={META_LINK_CLASS}>
            {category.label}
          </a>
        )}
        <InstallCount count={installs} />
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

      <MediaGallery name={plugin.name} media={plugin.media} />

      <div className="mt-10 border-t border-white/10 pt-10">
        <PluginOverview>{readmeBody(plugin.readme)}</PluginOverview>
      </div>
    </SiteShell>
  );
}
