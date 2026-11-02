import { createFileRoute } from "@tanstack/react-router";
import { RenderedDoc } from "~/components/rendered-doc";
import { docPageMeta } from "~/docs-meta";
import { routeLocale } from "~/i18n";

export const Route = createFileRoute("/{-$locale}/docs/")({
  head: ({ params }) => docPageMeta("", routeLocale(params)),
  component: DocsIndex,
});

function DocsIndex() {
  return <RenderedDoc slug="" />;
}
