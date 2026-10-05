import { createFileRoute, notFound } from "@tanstack/react-router";
import { useMemo } from "react";
import { pageMeta } from "~/meta";
import { getCategory, getRegistry } from "~/plugins";
import { BrowsePage } from "~/plugins/browse-page";
import {
  type BrowseQuery,
  DEFAULT_WINDOW,
  parseSearchTerm,
  parseSort,
  parseWindow,
} from "~/plugins/links";
import { PluginsNotFound } from "~/plugins/not-found";
import "~/styles.css";

export const Route = createFileRoute("/plugins/category/$slug")({
  validateSearch: (search: Record<string, unknown>): Omit<Partial<BrowseQuery>, "category"> => ({
    sort: parseSort(search.sort),
    window: parseWindow(search.window),
    q: parseSearchTerm(search.q),
  }),
  loader: async ({ params }) => {
    const category = getCategory(params.slug);
    if (!category) throw notFound();
    return { ...(await getRegistry()), category };
  },
  head: ({ params, loaderData }) =>
    pageMeta(
      loaderData ? `${loaderData.category.label} – Paseo plugins` : "Category not found – Paseo",
      loaderData?.category.description ?? "Category not found.",
      `/plugins/category/${params.slug}`,
    ),
  component: CategoryPage,
  notFoundComponent: () => (
    <PluginsNotFound title="Category not found">There is no plugin category here.</PluginsNotFound>
  ),
});

function CategoryPage() {
  const { plugins, installs, now, category } = Route.useLoaderData();
  const search = Route.useSearch();
  const query = useMemo<BrowseQuery>(
    () => ({
      category: category.slug,
      sort: search.sort ?? "installs",
      window: search.window ?? DEFAULT_WINDOW,
      q: search.q,
    }),
    [category.slug, search.sort, search.window, search.q],
  );
  return <BrowsePage plugins={plugins} installs={installs} now={now} query={query} />;
}
