import type { Locale } from "~/i18n";
import { groupTranslations, inLocale, parseFrontmatter } from "~/markdown-content";

interface PostFrontmatter {
  title: string;
  description: string;
  date: string;
  draft: boolean;
}

export interface Post {
  slug: string;
  frontmatter: PostFrontmatter;
  content: string;
  /** The language the post is shown in; English when it has no translation yet. */
  locale: Locale;
}

const postModules = import.meta.glob("../posts/**/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const postTranslations = groupTranslations(postModules);

function loadPosts(includeDrafts: boolean, locale: Locale): Post[] {
  const posts: Post[] = [];

  for (const group of postTranslations) {
    // The English original owns the post's identity: its slug, date and draft state.
    const original = parseFrontmatter(group.sources.en).data;
    const isDraft = group.path.includes("/drafts/") || original.draft === "true";
    if (isDraft && !includeDrafts) continue;

    const fileName = group.path.split("/").pop()!.replace(".md", "");
    const slug = isDraft ? `drafts/${fileName}` : fileName;
    const localized = inLocale(group, locale);
    const { data, content } = parseFrontmatter(localized.raw);

    posts.push({
      slug,
      frontmatter: {
        title: data.title ?? "",
        description: data.description ?? "",
        date: original.date ?? "",
        draft: isDraft,
      },
      content,
      locale: localized.locale,
    });
  }

  posts.sort(
    (a, b) => new Date(b.frontmatter.date).getTime() - new Date(a.frontmatter.date).getTime(),
  );

  return posts;
}

export function getPosts(locale: Locale, includeDrafts = false): Post[] {
  return loadPosts(includeDrafts, locale);
}

export function getPost(slug: string, locale: Locale): Post | undefined {
  return loadPosts(true, locale).find((p) => p.slug === slug);
}

export function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}
