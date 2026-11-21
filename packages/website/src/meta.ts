import { LOCALES, type Locale, languageAlternates, localizePath, OPEN_GRAPH_LOCALES } from "~/i18n";

export const SITE_ORIGIN = "https://paseo.sh";

interface PageMetaInput {
  title: string;
  description: string;
  /** The page's language-neutral path, such as `/docs/cli`. */
  path: string;
  locale: Locale;
  image?: string;
}

/** The absolute URL of a language-neutral path in a language. */
export function siteUrl(path: string, locale: Locale): string {
  return `${SITE_ORIGIN}${localizePath(path, locale)}`;
}

/**
 * Title, description, social cards, and the canonical and alternate-language links for a page that
 * exists in every site language. English is the `x-default` for visitors in any other language.
 */
export function pageMeta({ title, description, path, locale, image }: PageMetaInput) {
  const url = siteUrl(path, locale);
  return {
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:url", content: url },
      { property: "og:locale", content: OPEN_GRAPH_LOCALES[locale] },
      ...LOCALES.filter((other) => other !== locale).map((other) => ({
        property: "og:locale:alternate",
        content: OPEN_GRAPH_LOCALES[other],
      })),
      ...(image
        ? [
            { property: "og:image", content: image },
            { name: "twitter:image", content: image },
          ]
        : []),
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
    ],
    links: [
      { rel: "canonical", href: url },
      ...languageAlternates(path).map((alternate) => ({
        rel: "alternate",
        hrefLang: alternate.hreflang,
        href: `${SITE_ORIGIN}${alternate.path}`,
      })),
    ],
  };
}
