import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Breadcrumbs } from "~/components/breadcrumbs";
import { SiteShell } from "~/components/site-shell";
import { useLocalizePath } from "~/i18n";

/** What was not found; each has a title and an explanation under `plugins.notFound`. */
export type PluginsNotFoundKind = "author" | "plugin" | "category";

export function PluginsNotFound({ kind }: { kind: PluginsNotFoundKind }) {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  const crumbs = useMemo(
    () => [{ label: t("plugins.title"), href: "/plugins" }, { label: t("plugins.notFound.crumb") }],
    [t],
  );
  return (
    <SiteShell width="default">
      <Breadcrumbs items={crumbs} />
      <h1 className="text-3xl font-medium tracking-tight mb-4">
        {t(`plugins.notFound.${kind}Title`)}
      </h1>
      <p className="text-lg text-white/70 leading-relaxed max-w-2xl">
        {t(`plugins.notFound.${kind}Body`)}{" "}
        <Link to={localize("/plugins")} className="underline hover:text-white">
          {t("plugins.notFound.browseAll")}
        </Link>
      </p>
    </SiteShell>
  );
}
