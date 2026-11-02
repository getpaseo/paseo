import { DEFAULT_LOCALE, isLocale, type Locale } from "~/i18n";

/**
 * Long-form Markdown is written per language next to its English original: `cli.md` is English,
 * `cli.zh-CN.md` is its Chinese counterpart. Both share the English file's path as their identity,
 * so a page, its links, and its anchors are the same thing in every language.
 */
export interface MarkdownTranslations {
  /** The English file's path, which identifies the content in every language. */
  path: string;
  sources: Partial<Record<Locale, string>> & { en: string };
}

/** One piece of content in the language it is written in. */
export interface LocalizedMarkdown {
  raw: string;
  /** The language of `raw`; English when the requested language has no translation yet. */
  locale: Locale;
}

const TRANSLATION_SUFFIX = /\.([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*)\.md$/;

/**
 * Groups raw Markdown modules by the English file they translate. A translation without an English
 * original is a mistake in the content tree, so it fails loudly instead of becoming a page.
 */
export function groupTranslations(modules: Record<string, string>): MarkdownTranslations[] {
  const english = new Map<string, string>();
  const translations: { path: string; locale: Locale; raw: string }[] = [];
  for (const [path, raw] of Object.entries(modules)) {
    const suffix = TRANSLATION_SUFFIX.exec(path);
    if (suffix && isLocale(suffix[1]) && suffix[1] !== DEFAULT_LOCALE) {
      translations.push({ path: path.replace(TRANSLATION_SUFFIX, ".md"), locale: suffix[1], raw });
    } else {
      english.set(path, raw);
    }
  }
  const grouped = new Map<string, MarkdownTranslations>(
    [...english].map(([path, raw]) => [path, { path, sources: { en: raw } }]),
  );
  for (const translation of translations) {
    const group = grouped.get(translation.path);
    if (!group) throw new Error(`${translation.path} has a translation but no English original`);
    group.sources[translation.locale] = translation.raw;
  }
  return [...grouped.values()];
}

/** The content in a language, or the whole English original when it has no translation. */
export function inLocale(group: MarkdownTranslations, locale: Locale): LocalizedMarkdown {
  const raw = group.sources[locale];
  return raw === undefined ? { raw: group.sources.en, locale: DEFAULT_LOCALE } : { raw, locale };
}

export function parseFrontmatter(raw: string): { data: Record<string, string>; content: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, content: raw };

  const data: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line
      .slice(colonIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    data[key] = value;
  }

  return { data, content: match[2] };
}
