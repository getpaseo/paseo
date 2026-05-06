import { createFileRoute } from "@tanstack/react-router";
import ReactMarkdown from "react-markdown";
import changelogMarkdown from "../../../../CHANGELOG.md?raw";
import { SiteShell } from "~/components/site-shell";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/changelog")({
  head: () => ({
    meta: pageMeta(
      "Changelog - Paseo",
      "Product updates, fixes, and improvements shipped in each Paseo release.",
    ),
  }),
  component: Changelog,
});

function Changelog() {
  return (
    <SiteShell>
      <article className="changelog-markdown rounded-xl border border-border bg-card/40 p-6 md:p-8">
        <ReactMarkdown>{changelogMarkdown}</ReactMarkdown>
      </article>
    </SiteShell>
  );
}
