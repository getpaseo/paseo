import { createFileRoute } from "@tanstack/react-router";
import ReactMarkdown from "react-markdown";
import { getPost, formatDate } from "~/posts";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/blog/$")({
  head: ({ params }) => {
    const slug = params._splat ?? "";
    const post = getPost(slug);
    if (!post) return { meta: pageMeta("Not Found - Hubcode", "Post not found.") };
    return {
      meta: pageMeta(`${post.frontmatter.title} - Hubcode`, post.frontmatter.description),
    };
  },
  component: BlogPost,
});

function BlogPost() {
  const { _splat } = Route.useParams();
  const slug = _splat ?? "";
  const post = getPost(slug);

  if (!post) {
    return <p className="text-muted-foreground">Post not found.</p>;
  }

  return (
    <article>
      <div className="mb-8">
        <h1 className="text-4xl font-bold mb-2">{post.frontmatter.title}</h1>
        <span className="text-lg text-muted-foreground">
          {formatDate(new Date(post.frontmatter.date))}
        </span>
      </div>
      <div className="blog-prose">
        <ReactMarkdown>{post.content}</ReactMarkdown>
      </div>
    </article>
  );
}
