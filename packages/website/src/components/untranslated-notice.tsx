import { useTranslation } from "react-i18next";
import { type Locale, useLocale } from "~/i18n";

/**
 * Shown above content that has no translation in the page's language and is therefore shown whole in
 * its original language. Content is never mixed paragraph by paragraph.
 */
export function UntranslatedNotice({
  contentLocale,
  message,
}: {
  contentLocale: Locale;
  /** Overrides the default page-level notice, e.g. for one release of a translated page. */
  message?: string;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  if (contentLocale === locale) return null;
  return (
    <p
      role="note"
      className="not-prose mb-6 rounded-md border border-border px-4 py-3 text-sm text-muted-foreground"
    >
      {message ?? t("common.untranslated")}
    </p>
  );
}
