import { createFileRoute } from "@tanstack/react-router";
import ReactMarkdown from "react-markdown";
import { getPost, formatDate } from "~/posts";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/blog/$")({
  head: ({ params }) => {
    const slug = params._splat ?? "";
    const path = `/blog/${slug}`;
    const post = getPost(slug);
    if (!post) return pageMeta("Not Found - Paseo", "Post not found.", path);
    return pageMeta(`${post.frontmatter.title} - Paseo`, post.frontmatter.description, path);
  },
  component: BlogPost,
});

const markdownComponents = {
  a: ({ href, children, ...props }: React.ComponentPropsWithoutRef<"a">) => {
    const isExternal = typeof href === "string" && /^https?:\/\//i.test(href);

    return (
      <a
        {...props}
        href={href}
        rel={isExternal ? "nofollow noopener noreferrer" : undefined}
        target={isExternal ? "_blank" : undefined}
      >
        {children}
      </a>
    );
  },
};

function BlogPost() {
  const { _splat } = Route.useParams();
  const slug = _splat ?? "";
  const post = getPost(slug);

  if (!post) {
    return <p className="text-muted-foreground">Post not found.</p>;
  }

  return (
    <article className="pt-12 pb-16">
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
        <ReactMarkdown components={markdownComponents}>{post.content}</ReactMarkdown>
      </div>
    </article>
  );
}
