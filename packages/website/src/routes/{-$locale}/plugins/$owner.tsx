import { PluginContentLink } from "~/plugins/overview";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { type BreadcrumbItem, Breadcrumbs } from "~/components/breadcrumbs";
import { SiteShell } from "~/components/site-shell";
import { getTranslator, routeLocale } from "~/i18n";
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

export const Route = createFileRoute("/{-$locale}/plugins/$owner")({
  loader: async ({ params }) => {
    const registry = await getRegistry();
    const first = registry.plugins.find((plugin) => pluginOwner(plugin) === params.owner);
    if (!first) throw notFound();
    return { plugins: registry.plugins, installs: registry.installs, author: getAuthor(first) };
  },
  head: ({ params, loaderData }) => {
    const locale = routeLocale(params);
    const t = getTranslator(locale);
    const path = `/plugins/${params.owner}`;
    if (!loaderData)
      return pageMeta({
        title: t("plugins.meta.authorNotFoundTitle"),
        description: t("plugins.meta.authorNotFoundDescription"),
        path,
        locale,
      });
    const author = loaderData.author.name;
    return pageMeta({
      title: t("plugins.meta.authorTitle", { author }),
      description: t("plugins.meta.authorDescription", { author }),
      path,
      locale,
    });
  },
  component: AuthorPage,
  notFoundComponent: () => <PluginsNotFound kind="author" />,
});

const LINK_CLASS =
  "inline-flex items-center gap-1 text-xs text-extra-muted-foreground transition-colors hover:text-muted-foreground";

function AuthorPage() {
  const { plugins: allPlugins, installs, author } = Route.useLoaderData();
  const { t } = useTranslation();
  const crumbs = useMemo<BreadcrumbItem[]>(
    () => [{ label: t("plugins.title"), href: "/plugins" }, { label: author.name }],
    [author, t],
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
            {t("plugins.pluginCount", { count: plugins.length })}
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
