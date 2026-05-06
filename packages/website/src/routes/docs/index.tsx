import { createFileRoute } from "@tanstack/react-router";
import ReactMarkdown from "react-markdown";
import { getDoc } from "~/docs";
import { docsRehypePlugins } from "~/docs-rehype";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/docs/")({
  head: () => {
    const doc = getDoc("");
    if (!doc) return { meta: pageMeta("Docs - Paseo", "Paseo documentation.") };
    return {
      meta: pageMeta(`${doc.frontmatter.title} - Paseo Docs`, doc.frontmatter.description),
    };
  },
  component: DocsIndex,
});

function DocsIndex() {
  const doc = getDoc("");
  if (!doc) return <p className="text-muted-foreground">Doc not found.</p>;
  return <ReactMarkdown rehypePlugins={docsRehypePlugins}>{doc.content}</ReactMarkdown>;
}
