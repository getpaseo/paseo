import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { getTranslator, routeLocale, useLocale, useLocalizePath } from "~/i18n";
import { getPosts, formatDate } from "~/posts";
import { pageMeta } from "~/meta";

interface BlogSearch {
  drafts?: true;
}

export const Route = createFileRoute("/{-$locale}/blog/")({
  validateSearch: (search: Record<string, unknown>): BlogSearch => {
    const drafts = search.drafts === true || search.drafts === "" || search.drafts === "true";
    return drafts ? { drafts: true } : {};
  },
  head: ({ params }) => {
    const locale = routeLocale(params);
    const t = getTranslator(locale);
    return pageMeta({
      title: t("blog.metaTitle"),
      description: t("blog.metaDescription"),
      path: "/blog",
      locale,
    });
  },
  component: BlogIndex,
});

interface PostRowProps {
  slug: string;
  title: string;
  date: string;
  draft?: boolean;
}

function PostRow({ slug, title, date, draft }: PostRowProps) {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  return (
    <div className="flex flex-col-reverse items-start md:flex-row md:items-center gap-x-4">
      <span className="text-lg text-muted-foreground tabular-nums">
        {formatDate(new Date(date))}
      </span>
      <Link
        to={localize(`/blog/${slug}`)}
        className="text-lg text-foreground hover:text-primary transition-colors"
      >
        {title}
        {draft && (
          <span className="ml-2 text-xs px-2 py-1 bg-primary/20 text-primary rounded">
            {t("blog.draft")}
          </span>
        )}
      </Link>
    </div>
  );
}

function BlogIndex() {
  const { t } = useTranslation();
  const { drafts } = Route.useSearch();
  const posts = getPosts(useLocale(), drafts === true);

  return (
    <div>
      {drafts && (
        <div className="mb-6 p-4 bg-primary/10 rounded border-l-4 border-primary">
          <p className="text-sm text-foreground/80">{t("blog.showingDrafts")}</p>
        </div>
      )}
      <div className="space-y-2">
        {posts.map(({ slug, frontmatter }) => (
          <PostRow
            key={slug}
            slug={slug}
            title={frontmatter.title}
            date={frontmatter.date}
            draft={frontmatter.draft}
          />
        ))}
        {posts.length === 0 && <p className="text-muted-foreground">{t("blog.noPosts")}</p>}
      </div>
    </div>
  );
}
