import * as React from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { type Components } from "react-markdown";
import { SiteShell } from "~/components/site-shell";
import { UntranslatedNotice } from "~/components/untranslated-notice";
import { formatDate, localizePath, useLocale } from "~/i18n";
import { getLegalDocument, type LegalDocumentName } from "~/legal";

export function LegalPage({ name }: { name: LegalDocumentName }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const document = getLegalDocument(name, locale);
  const components = React.useMemo<Components>(
    () => ({
      a: ({ href, node: _node, ...props }) => {
        const external = href !== undefined && /^https?:\/\//i.test(href);
        return (
          <a
            {...props}
            href={href === undefined ? undefined : localizePath(href, locale)}
            {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          />
        );
      },
    }),
    [locale],
  );
  return (
    <SiteShell width="prose">
      <article className="space-y-4 text-white/70 leading-relaxed [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:text-white [&_h2]:pt-4 [&_h2]:text-xl [&_h2]:font-medium [&_h2]:text-white [&_li]:pl-1 [&_strong]:font-medium [&_strong]:text-white [&_ul]:ml-5 [&_ul]:list-disc [&_ul]:space-y-1">
        <header className="space-y-3 pb-4">
          <h1 className="text-3xl font-medium text-white">{document.title}</h1>
          <p className="text-sm text-white/50">
            {t("legal.lastUpdated", { date: formatDate(document.lastUpdated, locale, "long") })}
          </p>
        </header>
        <UntranslatedNotice contentLocale={document.locale} />
        <div className="space-y-4" lang={document.locale}>
          <ReactMarkdown components={components}>{document.content}</ReactMarkdown>
        </div>
      </article>
    </SiteShell>
  );
}
