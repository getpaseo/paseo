import type { Locale } from "~/i18n";
import { groupTranslations, inLocale, parseFrontmatter } from "~/markdown-content";

export interface AlternativePage {
  slug: string;
  name: string;
  /** The language-neutral page path. */
  href: string;
  title: string;
  description: string;
  content: string;
  /** The language `content` is written in. */
  locale: Locale;
  order: number;
}

const alternativeModules = import.meta.glob("../content/alternatives/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const alternativeTranslations = groupTranslations(alternativeModules);

function loadAlternativePages(locale: Locale): AlternativePage[] {
  const pages: AlternativePage[] = [];

  for (const group of alternativeTranslations) {
    const fileName = group.path.split("/").pop() ?? "";
    const slug = fileName.replace(/\.md$/, "");
    const localized = inLocale(group, locale);
    const { data, content } = parseFrontmatter(localized.raw);
    const order = Number.parseInt(data.order ?? "999", 10);

    pages.push({
      slug,
      name: data.nav ?? data.title ?? slug,
      href: `/alternatives/${slug}`,
      title: data.title ?? slug,
      description: data.description ?? "",
      content,
      locale: localized.locale,
      order: Number.isFinite(order) ? order : 999,
    });
  }

  pages.sort((a, b) => a.order - b.order);
  return pages;
}

const cached = new Map<Locale, AlternativePage[]>();

export function getAlternativePages(locale: Locale): AlternativePage[] {
  let pages = cached.get(locale);
  if (!pages) {
    pages = loadAlternativePages(locale);
    cached.set(locale, pages);
  }
  return pages;
}

export function getAlternativePage(slug: string, locale: Locale): AlternativePage | undefined {
  return getAlternativePages(locale).find((p) => p.slug === slug);
}
