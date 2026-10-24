import { createFileRoute } from "@tanstack/react-router";
import { RenderedDoc } from "~/components/rendered-doc";
import { docPageMeta } from "~/docs-meta";
import { routeLocale } from "~/i18n";

export const Route = createFileRoute("/{-$locale}/docs/$")({
  head: ({ params }) => docPageMeta(params._splat ?? "", routeLocale(params)),
  component: DocsPage,
});

function DocsPage() {
  const { _splat } = Route.useParams();
  return <RenderedDoc slug={_splat ?? ""} />;
}
