import { DocsMarkdown } from "~/components/docs-markdown";
import { SiteShell } from "~/components/site-shell";
import { getAlternativePage } from "~/data/alternative-pages";
import { pageMeta } from "~/meta";

export function alternativeRouteOptions(slug: string) {
  const page = getAlternativePage(slug);

  return {
    head: () =>
      pageMeta(
        page?.title ?? "Alternative - Paseo",
        page?.description ?? "",
        `/alternatives/${slug}`,
      ),
    component: function AlternativePageRoute() {
      return <AlternativePageContent slug={slug} />;
    },
  };
}

function AlternativePageContent({ slug }: { slug: string }) {
  const page = getAlternativePage(slug);

  if (!page) {
    return (
      <SiteShell width="default">
        <p className="text-muted-foreground">Page not found.</p>
      </SiteShell>
    );
  }

  return (
    <SiteShell width="default">
      <DocsMarkdown>{page.content}</DocsMarkdown>
    </SiteShell>
  );
}
