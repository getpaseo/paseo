import { createFileRoute, notFound } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { GitHubIcon } from "~/components/brand-icons";
import { CodeBlock } from "~/components/code-block";
import { PluginOverview, PluginContentLink } from "~/plugins/overview";
import { SiteShell } from "~/components/site-shell";
import { UntranslatedNotice } from "~/components/untranslated-notice";
import { getTranslator, routeLocale, useLocale, useLocalizePath } from "~/i18n";
import { pageMeta } from "~/meta";
import {
  firstMediaImage,
  getAuthor,
  getCategory,
  getRegistry,
  getRegistryPlugin,
  installCommand,
  npmUrl,
  pluginListing,
  pluginOverview,
  pluginVersion,
  readmeBody,
  reportBugUrl,
} from "~/plugins";
import { AuthorAvatar, AuthorLink } from "~/plugins/author-link";
import { InstallCount } from "~/plugins/install-count";
import { categoryHref } from "~/plugins/links";
import { MediaGallery } from "~/plugins/media-gallery";
import { PluginsNotFound } from "~/plugins/not-found";
import "~/styles.css";

export const Route = createFileRoute("/{-$locale}/plugins/$owner_/$slug")({
  loader: async ({ params }) => {
    const [registry, plugin] = await Promise.all([
      getRegistry(),
      getRegistryPlugin({ data: `${params.owner}/${params.slug}` }),
    ]);
    if (!plugin) throw notFound();
    return { plugin, installs: registry.installs[plugin.id]?.all ?? 0 };
  },
  head: ({ params, loaderData }) => {
    const locale = routeLocale(params);
    const t = getTranslator(locale);
    const path = `/plugins/${params.owner}/${params.slug}`;
    if (!loaderData)
      return pageMeta({
        title: t("plugins.meta.pluginNotFoundTitle"),
        description: t("plugins.meta.pluginNotFoundDescription"),
        path,
        locale,
      });
    const listing = pluginListing(loaderData.plugin, locale);
    return pageMeta({
      title: t("plugins.meta.pluginTitle", { name: listing.name }),
      description: listing.description,
      path,
      locale,
      image: firstMediaImage(loaderData.plugin),
    });
  },
  component: PluginPage,
  notFoundComponent: () => <PluginsNotFound kind="plugin" />,
});

const META_LINK_CLASS =
  "inline-flex items-center gap-1 text-xs text-extra-muted-foreground transition-colors hover:text-muted-foreground";
const REPORT_BUG_CLASS =
  "inline-flex items-center gap-2 rounded-lg border border-white/12 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground";
const AUTHOR_LINK_CLASS =
  "inline-flex items-center gap-1.5 text-xs text-extra-muted-foreground transition-colors hover:text-muted-foreground";

function PluginPage() {
  const { plugin, installs } = Route.useLoaderData();
  const { t } = useTranslation();
  const locale = useLocale();
  const localize = useLocalizePath();
  const listing = pluginListing(plugin, locale);
  const overview = pluginOverview(plugin, locale);
  const category = getCategory(plugin.categories[0]);
  const author = getAuthor(plugin);
  const npm = npmUrl(plugin);
  const reportBug = reportBugUrl(plugin);

  return (
    <SiteShell width="default">
      <a
        href={localize("/plugins")}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← {t("plugins.back")}
      </a>
      <h1 className="mt-4 text-3xl font-medium tracking-tight">{listing.name}</h1>
      <p className="mt-3 text-lg leading-relaxed text-white/70">{listing.description}</p>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="w-fit max-w-full">
          <CodeBlock size="sm">{installCommand(plugin)}</CodeBlock>
        </div>
        {reportBug && (
          <PluginContentLink href={reportBug} className={REPORT_BUG_CLASS}>
            <GitHubIcon className="h-4 w-4" />
            {t("plugins.reportBug")}
          </PluginContentLink>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 text-xs text-extra-muted-foreground [&>*+*]:before:mr-2 [&>*+*]:before:content-['·'_/_'']">
        <AuthorLink author={author} className={AUTHOR_LINK_CLASS}>
          <AuthorAvatar author={author} size="xs" />
          {author.name}
        </AuthorLink>
        {category && (
          <a href={localize(categoryHref(category))} className={META_LINK_CLASS}>
            {t(`plugins.categories.${category}.label`)}
          </a>
        )}
        <InstallCount count={installs} />
        <span className="font-mono">{pluginVersion(plugin)}</span>
        <PluginContentLink href={plugin.repository.url} className={META_LINK_CLASS}>
          {t("plugins.source")}
          <ExternalLink className="h-3 w-3" />
        </PluginContentLink>
        {npm && (
          <PluginContentLink href={npm} className={META_LINK_CLASS}>
            npm
            <ExternalLink className="h-3 w-3" />
          </PluginContentLink>
        )}
      </div>

      <MediaGallery name={listing.name} media={plugin.media} />

      <div className="mt-10 border-t border-white/10 pt-10">
        <UntranslatedNotice
          contentLocale={overview.locale}
          message={t("plugins.untranslatedOverview")}
        />
        <PluginOverview lang={overview.locale}>{readmeBody(overview.raw)}</PluginOverview>
      </div>
    </SiteShell>
  );
}
