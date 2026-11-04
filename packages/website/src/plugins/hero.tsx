import { useTranslation } from "react-i18next";
import { ContributeButtons } from "./contribute-links";
import type { BrowseQuery } from "./links";
import { PluginSearch } from "./plugin-search";

interface PluginsHeroProps {
  pluginCount: number;
  authorCount: number;
  /** Where the search box sends its term. */
  searchScope: BrowseQuery;
}

/** Header of the plugin directory: title, counts, and copy, then the contribute buttons and search. */
export function PluginsHero({ pluginCount, authorCount, searchScope }: PluginsHeroProps) {
  const { t } = useTranslation();
  return (
    <header>
      <h1 className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-3xl font-medium tracking-tight">{t("plugins.title")}</span>
        <span className="text-sm font-normal tabular-nums text-extra-muted-foreground">
          {t("plugins.counts", {
            plugins: t("plugins.pluginCount", { count: pluginCount }),
            authors: t("plugins.authorCount", { count: authorCount }),
          })}
        </span>
      </h1>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
        {t("plugins.lead")}
      </p>
      <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-3">
          <ContributeButtons />
        </div>
        <PluginSearch scope={searchScope} className="w-full sm:w-64" />
      </div>
    </header>
  );
}
