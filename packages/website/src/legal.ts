import type { Locale } from "~/i18n";
import { groupTranslations, inLocale, parseFrontmatter } from "~/markdown-content";

export type LegalDocumentName = "privacy" | "terms";

export interface LegalDocument {
  title: string;
  description: string;
  /** ISO date of the English original's last material change. */
  lastUpdated: string;
  content: string;
  /** The language the document is shown in; English when it has no translation yet. */
  locale: Locale;
}

const legalModules = import.meta.glob("../legal/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const legalTranslations = groupTranslations(legalModules);

export function getLegalDocument(name: LegalDocumentName, locale: Locale): LegalDocument {
  const group = legalTranslations.find((candidate) => candidate.path.endsWith(`/${name}.md`));
  if (!group) throw new Error(`Missing legal document: ${name}`);
  const localized = inLocale(group, locale);
  const { data, content } = parseFrontmatter(localized.raw);
  return {
    title: data.title ?? "",
    description: data.description ?? "",
    lastUpdated: parseFrontmatter(group.sources.en).data.lastUpdated ?? "",
    content,
    locale: localized.locale,
  };
}
