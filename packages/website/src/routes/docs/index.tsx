import { createFileRoute } from "@tanstack/react-router";
import { DocsMarkdown } from "~/components/docs-markdown";
import { DocsMarkdownActions } from "~/components/docs-markdown-actions";
import { DocsSourceFooter } from "~/components/docs-source-footer";
import { getDoc } from "~/docs";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/docs/")({
  head: () => {
    const doc = getDoc("");
    if (!doc)
      return pageMeta(
        "Docs - Paseo",
        "Install Paseo and start running coding agents from your phone, desktop, and terminal.",
        "/docs",
      );
    return pageMeta(`${doc.frontmatter.title} - Paseo Docs`, doc.frontmatter.description, "/docs");
  },
  component: DocsIndex,
});

function DocsIndex() {
  const doc = getDoc("");
  if (!doc) return <p className="text-muted-foreground">Doc not found.</p>;
  return (
    <>
      <DocsMarkdownActions content={doc.content} markdownHref="/docs.md" />
      <DocsMarkdown>{doc.content}</DocsMarkdown>
      <DocsSourceFooter doc={doc} />
    </>
  );
}
