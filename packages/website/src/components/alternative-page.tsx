import { useTranslation } from "react-i18next";
import { DocsMarkdown } from "~/components/docs-markdown";
import { SiteShell } from "~/components/site-shell";
import { UntranslatedNotice } from "~/components/untranslated-notice";
import { getAlternativePage } from "~/data/alternative-pages";
import { getTranslator, routeLocale, useLocale } from "~/i18n";
import { pageMeta } from "~/meta";

export function alternativeRouteOptions(slug: string) {
  return {
    head: ({ params }: { params: { locale?: string } }) => {
      const locale = routeLocale(params);
      const page = getAlternativePage(slug, locale);
      return pageMeta({
        title: page?.title ?? getTranslator(locale)("common.notFoundTitle"),
        description: page?.description ?? "",
        path: `/alternatives/${slug}`,
        locale,
      });
    },
    component: function AlternativePageRoute() {
      return <AlternativePageContent slug={slug} />;
    },
  };
}

function AlternativePageContent({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const page = getAlternativePage(slug, useLocale());

  if (!page) {
    return (
      <SiteShell width="default">
        <p className="text-muted-foreground">{t("common.notFound")}</p>
      </SiteShell>
    );
  }

  return (
    <SiteShell width="default">
      <UntranslatedNotice contentLocale={page.locale} />
      <div className="comparison-prose">
        <DocsMarkdown lang={page.locale}>{page.content}</DocsMarkdown>
      </div>
    </SiteShell>
  );
}
