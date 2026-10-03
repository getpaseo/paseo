import { createFileRoute } from "@tanstack/react-router";
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
  sortPlugins,
} from "~/plugins";
import { AuthorAvatar } from "~/plugins/author-link";
import { PluginsNotFound } from "~/plugins/not-found";
import { PLUGIN_GRID_CLASS, PluginCard } from "~/plugins/plugin-card";
import "~/styles.css";

export const Route = createFileRoute("/plugins/$owner")({
  head: ({ params }) =>
    pageMeta(
      `${params.owner} – Paseo plugins`,
      `Paseo plugins published by ${params.owner}.`,
      `/plugins/${params.owner}`,
    ),
  loader: () => getRegistry(),
  component: AuthorPage,
});

const LINK_CLASS =
  "inline-flex items-center gap-1 text-xs text-extra-muted-foreground transition-colors hover:text-muted-foreground";

function AuthorPage() {
  const { owner: username } = Route.useParams();
  const { plugins: allPlugins } = Route.useLoaderData();
  const first = allPlugins.find((plugin) => plugin.author.github === username);
  const author = first ? getAuthor(first.author) : null;
  const crumbs = useMemo<BreadcrumbItem[]>(
    () => (author ? [{ label: "Plugins", href: "/plugins" }, { label: author.name }] : []),
    [author],
  );

  if (!author) {
    return (
      <PluginsNotFound title="Author not found">
        Nobody with that GitHub owner has a plugin listed.
      </PluginsNotFound>
    );
  }

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
