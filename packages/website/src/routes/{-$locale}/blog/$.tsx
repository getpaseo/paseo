import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import { UntranslatedNotice } from "~/components/untranslated-notice";
import { getTranslator, type Locale, localizePath, routeLocale, useLocale } from "~/i18n";
import { getPost, formatDate } from "~/posts";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/{-$locale}/blog/$")({
  head: ({ params }) => {
    const locale = routeLocale(params);
    const t = getTranslator(locale);
    const slug = params._splat ?? "";
    const path = `/blog/${slug}`;
    const post = getPost(slug, locale);
    if (!post) {
      return pageMeta({
        title: t("blog.notFoundTitle"),
        description: t("blog.notFound"),
        path,
        locale,
      });
    }
    return pageMeta({
      title: t("blog.postTitle", { title: post.frontmatter.title }),
      description: post.frontmatter.description,
      path,
      locale,
    });
  },
  component: BlogPost,
});

function markdownComponents(locale: Locale) {
  return {
    a: ({ href, children, ...props }: React.ComponentPropsWithoutRef<"a">) => {
      const isExternal = typeof href === "string" && /^https?:\/\//i.test(href);

      return (
        <a
          {...props}
          href={href === undefined ? undefined : localizePath(href, locale)}
          rel={isExternal ? "nofollow noopener noreferrer" : undefined}
          target={isExternal ? "_blank" : undefined}
        >
          {children}
        </a>
      );
    },
  };
}

function BlogPost() {
  const { t } = useTranslation();
  const locale = useLocale();
  const { _splat } = Route.useParams();
  const slug = _splat ?? "";
  const post = getPost(slug, locale);
  const components = React.useMemo(() => markdownComponents(locale), [locale]);

  if (!post) {
    return <p className="text-muted-foreground">{t("blog.notFound")}</p>;
  }

  return (
    <article className="pt-12 pb-16" lang={post.locale}>
      <UntranslatedNotice contentLocale={post.locale} />
      <div className="mb-8">
        <h1 className="text-4xl font-bold mb-4">{post.frontmatter.title}</h1>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <a
            href="https://x.com/moboudra"
            target="_blank"
            rel="nofollow noopener noreferrer"
            className="flex items-center gap-3 text-foreground hover:text-primary transition-colors"
          >
            <img src="/9viSwGkz_400x400.jpg" alt="Mo Boudra" className="size-6 rounded-full" />
            <span className="font-medium">Mo Boudra</span>
          </a>
          <span>·</span>
          <span className="tabular-nums">{formatDate(new Date(post.frontmatter.date))}</span>
        </div>
      </div>
      <div className="blog-prose">
        <ReactMarkdown components={components}>{post.content}</ReactMarkdown>
      </div>
    </article>
  );
}
