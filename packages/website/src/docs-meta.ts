import { getDoc } from "~/docs";
import { getTranslator, type Locale } from "~/i18n";
import { pageMeta } from "~/meta";

/** Title, description, and language links for a docs page. */
export function docPageMeta(slug: string, locale: Locale) {
  const t = getTranslator(locale);
  const path = slug === "" ? "/docs" : `/docs/${slug}`;
  const doc = getDoc(slug, locale);
  if (!doc) {
    return pageMeta({
      title: t("docs.notFoundTitle"),
      description: t("docs.notFound"),
      path,
      locale,
    });
  }
  return pageMeta({
    title: t("docs.pageTitle", { title: doc.frontmatter.title }),
    description: doc.frontmatter.description,
    path,
    locale,
  });
}
