/**
 * The site's languages and how a language shows in a URL. English pages keep their unprefixed
 * paths; every other language lives under its tag, so `/docs` and `/zh-CN/docs` are the same page.
 */
export const LOCALES = ["en", "zh-CN"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/** Each language named in itself, for the language selector. */
export const LANGUAGE_NAMES: Record<Locale, string> = {
  en: "English",
  "zh-CN": "简体中文",
};

/** Each language abbreviated, for the closed language selector. */
export const LANGUAGE_ABBREVIATIONS: Record<Locale, string> = {
  en: "EN",
  "zh-CN": "ZH",
};

/** `og:locale` values, which use an underscore and a region. */
export const OPEN_GRAPH_LOCALES: Record<Locale, string> = {
  en: "en_US",
  "zh-CN": "zh_CN",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * The language named by the optional `{-$locale}` route segment, or null when the segment is not a
 * prefixed language. English is never spelled out in a URL, so `/en/docs` is not a page.
 */
export function localeFromParam(param: string | undefined): Locale | null {
  if (param === undefined) return DEFAULT_LOCALE;
  return param !== DEFAULT_LOCALE && isLocale(param) ? param : null;
}

/**
 * The language of a route under `{-$locale}`. The layout route only matches valid languages, so
 * route functions such as `head` can read it from their params.
 */
export function routeLocale(params: { locale?: string }): Locale {
  return localeFromParam(params.locale) ?? DEFAULT_LOCALE;
}

/** The `{-$locale}` segment value for a language; English has none. */
export function localeParam(locale: Locale): string | undefined {
  return locale === DEFAULT_LOCALE ? undefined : locale;
}

const NON_PAGE_PREFIXES = ["/api/", "/_serverFn/", "/schemas/", "/plugins/thumb/"];

/**
 * Whether a site-relative URL names a page that exists in every language. Files such as images,
 * `.md` sources, `llms.txt`, and API endpoints are shared by all languages and keep their path.
 */
export function isPagePath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  const pathname = path.split(/[?#]/, 1)[0];
  if (NON_PAGE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;
  const lastSegment = pathname.split("/").at(-1) ?? "";
  return !lastSegment.includes(".");
}

/**
 * Splits a site path into its language and the language-neutral path, keeping any query and hash.
 * `/zh-CN/docs?q=1` is `{ locale: "zh-CN", path: "/docs?q=1" }`; `/docs` is English.
 */
export function splitLocalePath(path: string): { locale: Locale; path: string } {
  for (const locale of LOCALES) {
    if (locale === DEFAULT_LOCALE) continue;
    const prefix = `/${locale}`;
    if (path === prefix) return { locale, path: "/" };
    if (path.startsWith(prefix) && /[/?#]/.test(path.charAt(prefix.length))) {
      const rest = path.slice(prefix.length);
      return { locale, path: rest.startsWith("/") ? rest : `/${rest}` };
    }
  }
  return { locale: DEFAULT_LOCALE, path };
}

/**
 * The URL of a language-neutral site path in a language. Paths that are not pages, external URLs,
 * and fragments are returned unchanged.
 */
export function localizePath(path: string, locale: Locale): string {
  if (!isPagePath(path)) return path;
  return withLocalePrefix(splitLocalePath(path).path, locale);
}

/**
 * Puts a language-neutral site path under a language's prefix. Use it directly for files that exist
 * per language, such as a doc's `.md` source; pages go through `localizePath`.
 */
export function withLocalePrefix(path: string, locale: Locale): string {
  if (locale === DEFAULT_LOCALE) return path;
  if (path === "/" || path.startsWith("/?") || path.startsWith("/#")) {
    return `/${locale}${path.slice(1)}`;
  }
  return `/${locale}${path}`;
}

/**
 * A page's path in every language, tagged for `hreflang`, plus English again as `x-default` for
 * readers in any other language. Page metadata and the sitemaps list the same set.
 */
export function languageAlternates(path: string): { hreflang: string; path: string }[] {
  return [
    ...LOCALES.map((locale) => ({ hreflang: locale, path: localizePath(path, locale) })),
    { hreflang: "x-default", path: localizePath(path, DEFAULT_LOCALE) },
  ];
}
