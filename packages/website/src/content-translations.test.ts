import { describe, expect, it } from "vitest";
import { getAlternativePages } from "~/data/alternative-pages";
import { getDocs, parseHeadings } from "~/docs";
import type { Locale } from "~/i18n";
import { getLegalDocument, type LegalDocumentName } from "~/legal";
import { getPosts } from "~/posts";

/**
 * First-party pages in both languages, paired by path. Every page ships in Chinese, so a missing
 * translation is a failure here rather than a silent English fallback in production.
 */
interface ContentPair {
  path: string;
  /** Whether headings render with `#` anchors; blog posts and legal pages have none. */
  anchored: boolean;
  english: { content: string; locale: Locale };
  chinese: { content: string; locale: Locale };
}

const LEGAL_DOCUMENTS: LegalDocumentName[] = ["privacy", "terms"];

function pairs<T extends { content: string; locale: Locale }>(
  english: T[],
  chinese: T[],
  pathOf: (page: T) => string,
  anchored: boolean,
): ContentPair[] {
  const byPath = new Map(chinese.map((page) => [pathOf(page), page]));
  return english.map((page) => ({
    path: pathOf(page),
    anchored,
    english: page,
    chinese: byPath.get(pathOf(page)) ?? { content: "", locale: "en" },
  }));
}

const CONTENT: ContentPair[] = [
  ...pairs(getDocs("en"), getDocs("zh-CN"), (doc) => doc.href, true),
  ...pairs(getPosts("en"), getPosts("zh-CN"), (post) => `/blog/${post.slug}`, false),
  ...pairs(getAlternativePages("en"), getAlternativePages("zh-CN"), (page) => page.href, true),
  ...LEGAL_DOCUMENTS.map((name) => ({
    path: `/${name}`,
    anchored: false,
    english: getLegalDocument(name, "en"),
    chinese: getLegalDocument(name, "zh-CN"),
  })),
];

/** Sections in page order, with the anchor `#` links land on where the page renders one. */
function sections(content: string, anchored: boolean): string[] {
  return parseHeadings(content).map(
    (heading) => `h${heading.depth}${anchored ? ` #${heading.id}` : ""}`,
  );
}

function untranslated(pair: ContentPair): boolean {
  return pair.chinese.locale !== "zh-CN";
}

/** The sections a translation adds, drops, reorders, or anchors differently, as a readable diff. */
function sectionMismatch(pair: ContentPair): string[] {
  const english = sections(pair.english.content, pair.anchored);
  const chinese = sections(pair.chinese.content, pair.anchored);
  if (english.join() === chinese.join()) return [];
  return [`${pair.path}: English ${english.join(" ")} | Chinese ${chinese.join(" ")}`];
}

describe("Chinese content", () => {
  it("covers every first-party page", () => {
    expect(CONTENT.length).toBeGreaterThan(70);
    expect(CONTENT.filter(untranslated).map((pair) => pair.path)).toEqual([]);
  });

  it("has every English section, in order, under the English anchor", () => {
    // Pin each translated heading with the English anchor: `## 运行 Agent {#running-agents}`.
    expect(CONTENT.flatMap(sectionMismatch)).toEqual([]);
  });
});
