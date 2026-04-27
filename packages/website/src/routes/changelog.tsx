import { createFileRoute } from "@tanstack/react-router";
import ReactMarkdown from "react-markdown";
import changelogMarkdown from "../../../../CHANGELOG.md?raw";
import { pageMeta } from "~/meta";
import { SiteHeader } from "~/components/site-header";

export const Route = createFileRoute("/changelog")({
  head: () => ({
    meta: pageMeta(
      "Changelog - Hubcode",
      "Product updates, fixes, and improvements shipped in each Hubcode release.",
    ),
  }),
  component: Changelog,
});

function Changelog() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto p-6 md:p-12">
        <div className="mb-8">
          <SiteHeader />
        </div>
        <article className="changelog-markdown rounded-xl border border-border bg-card/40 p-6 md:p-8">
          <ReactMarkdown>{changelogMarkdown}</ReactMarkdown>
        </article>
      </div>
    </div>
  );
}
