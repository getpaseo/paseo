import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { SiteShell } from "~/components/site-shell";
import { LocaleProvider, useLocalizePath } from "~/i18n";

/**
 * The page for a URL that matches no page, in the language its path names. Unmatched URLs can sit
 * outside the language layout, so this provides the language itself.
 */
export function NotFoundPage() {
  return (
    <LocaleProvider>
      <NotFoundContent />
    </LocaleProvider>
  );
}

function NotFoundContent() {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  return (
    <SiteShell width="default">
      <h1 className="mb-4 text-3xl font-medium tracking-tight">{t("common.notFound")}</h1>
      <Link to={localize("/")} className="text-white/70 underline hover:text-white">
        {t("common.backHome")}
      </Link>
    </SiteShell>
  );
}
