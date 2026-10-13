import { PluginContentLink } from "~/plugins/overview";
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
  mostInstalled,
  pluginOwner,
} from "~/plugins";
import { AuthorAvatar } from "~/plugins/author-link";
import { PluginsNotFound } from "~/plugins/not-found";
import { InstallCount } from "~/plugins/install-count";
import { PluginCard } from "~/plugins/plugin-card";
import "~/styles.css";

export const Route = createFileRoute("/plugins/$owner")({
  loader: async ({ params }) => {
    const registry = await getRegistry();
    const first = registry.plugins.find((plugin) => pluginOwner(plugin) === params.owner);
    if (!first) throw notFound();
    return { plugins: registry.plugins, installs: registry.installs, author: getAuthor(first) };
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
  const { plugins: allPlugins, installs, author } = Route.useLoaderData();
  const crumbs = useMemo<BreadcrumbItem[]>(
    () => [{ label: "Plugins", href: "/plugins" }, { label: author.name }],
    [author],
  );

  const plugins = mostInstalled(getPluginsByAuthor(allPlugins, author.username), installs, "all");
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
              <PluginContentLink href={authorNpmUrl(author)} className={LINK_CLASS}>
                npm
                <ExternalLink className="h-3 w-3" />
              </PluginContentLink>
            )}
            {github && (
              <PluginContentLink href={github} className={LINK_CLASS}>
                GitHub
                <ExternalLink className="h-3 w-3" />
              </PluginContentLink>
            )}
          </div>
        </div>
      </div>

      <div className="mt-12 grid gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
        {plugins.map((plugin) => (
          <PluginCard key={plugin.id} plugin={plugin}>
            <InstallCount count={installs[plugin.id]?.all ?? 0} />
          </PluginCard>
        ))}
      </div>
    </SiteShell>
  );
}
