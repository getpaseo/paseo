import { createFileRoute, notFound } from "@tanstack/react-router";
import { useMemo } from "react";
import { getTranslator, routeLocale } from "~/i18n";
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

export const Route = createFileRoute("/{-$locale}/plugins/category/$slug")({
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
  head: ({ params, loaderData }) => {
    const locale = routeLocale(params);
    const t = getTranslator(locale);
    const path = `/plugins/category/${params.slug}`;
    if (!loaderData)
      return pageMeta({
        title: t("plugins.meta.categoryNotFoundTitle"),
        description: t("plugins.meta.categoryNotFoundDescription"),
        path,
        locale,
      });
    return pageMeta({
      title: t("plugins.meta.categoryTitle", {
        category: t(`plugins.categories.${loaderData.category}.label`),
      }),
      description: t(`plugins.categories.${loaderData.category}.description`),
      path,
      locale,
    });
  },
  component: CategoryPage,
  notFoundComponent: () => <PluginsNotFound kind="category" />,
});

function CategoryPage() {
  const { plugins, installs, now, category } = Route.useLoaderData();
  const search = Route.useSearch();
  const query = useMemo<BrowseQuery>(
    () => ({
      category,
      sort: search.sort ?? "installs",
      window: search.window ?? DEFAULT_WINDOW,
      q: search.q,
    }),
    [category, search.sort, search.window, search.q],
  );
  return <BrowsePage plugins={plugins} installs={installs} now={now} query={query} />;
}
