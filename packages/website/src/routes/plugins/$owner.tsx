import { createFileRoute, notFound } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { useMemo } from "react";
import { type BreadcrumbItem, Breadcrumbs } from "~/components/breadcrumbs";
import { SiteShell } from "~/components/site-shell";
import { pageMeta } from "~/meta";
import {
  authorGitHubUrl,
  authorNpmUrl,
  getAuthor,
  getRegistry,
  getPluginsByAuthor,
  pluginOwner,
  sortPlugins,
} from "~/plugins";
import { AuthorAvatar } from "~/plugins/author-link";
import { PluginsNotFound } from "~/plugins/not-found";
import { PLUGIN_GRID_CLASS, PluginCard } from "~/plugins/plugin-card";
import "~/styles.css";

export const Route = createFileRoute("/plugins/$owner")({
  loader: async ({ params }) => {
    const registry = await getRegistry();
    const first = registry.plugins.find((plugin) => pluginOwner(plugin) === params.owner);
    if (!first) throw notFound();
    return { plugins: registry.plugins, author: getAuthor(first) };
  },
  head: ({ params, loaderData }) =>
    pageMeta(
      loaderData ? `${loaderData.author.name} – Paseo plugins` : "Author not found – Paseo",
      loaderData ? `Paseo plugins published by ${loaderData.author.name}.` : "Author not found.",
      `/plugins/${params.owner}`,
    ),
  component: AuthorPage,
  notFoundComponent: () => (
    <PluginsNotFound title="Author not found">
      Nobody with that GitHub owner has a plugin listed.
    </PluginsNotFound>
  ),
});

const LINK_CLASS =
  "inline-flex items-center gap-1 text-xs text-extra-muted-foreground transition-colors hover:text-muted-foreground";

function AuthorPage() {
  const { plugins: allPlugins, author } = Route.useLoaderData();
  const crumbs = useMemo<BreadcrumbItem[]>(
    () => [{ label: "Plugins", href: "/plugins" }, { label: author.name }],
    [author],
  );

  const plugins = sortPlugins(getPluginsByAuthor(allPlugins, author.username), "popular");
  const github = authorGitHubUrl(author);

  return (
    <SiteShell width="default">
      <Breadcrumbs items={crumbs} />
      <div className="flex items-start gap-4">
        <AuthorAvatar author={author} size="lg" />
        <div className="space-y-2">
          <h1 className="text-3xl font-medium tracking-tight">{author.name}</h1>
          <p className="text-sm text-muted-foreground">
            {plugins.length} {plugins.length === 1 ? "plugin" : "plugins"}
          </p>
          <div className="flex items-center gap-4 pt-1">
            {authorNpmUrl(author) && (
              <a
                href={authorNpmUrl(author)}
                target="_blank"
                rel="noopener noreferrer"
                className={LINK_CLASS}
              >
                npm
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
            {github && (
              <a href={github} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
                GitHub
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </div>
      </div>

      <div className={`mt-12 ${PLUGIN_GRID_CLASS}`}>
        {plugins.map((plugin) => (
          <PluginCard key={plugin.id} plugin={plugin} />
        ))}
      </div>
    </SiteShell>
  );
}
