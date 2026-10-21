import { useTranslation } from "react-i18next";
import { DocsMarkdown } from "~/components/docs-markdown";
import { DocsMarkdownActions } from "~/components/docs-markdown-actions";
import { DocsSourceFooter } from "~/components/docs-source-footer";
import { UntranslatedNotice } from "~/components/untranslated-notice";
import { docMarkdownPath, getDoc } from "~/docs";
import { useLocale } from "~/i18n";

export function RenderedDoc({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const doc = getDoc(slug, useLocale());

  if (!doc) {
    return <p className="text-muted-foreground">{t("docs.notFound")}</p>;
  }

  return (
    <>
      <UntranslatedNotice contentLocale={doc.locale} />
      <DocsMarkdownActions content={doc.content} markdownHref={docMarkdownPath(doc)} />
      <DocsMarkdown lang={doc.locale}>{doc.content}</DocsMarkdown>
      <DocsSourceFooter doc={doc} />
    </>
  );
}
