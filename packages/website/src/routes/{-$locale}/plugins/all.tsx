import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { getTranslator, routeLocale } from "~/i18n";
import { pageMeta } from "~/meta";
import { getRegistry } from "~/plugins";
import { BrowsePage } from "~/plugins/browse-page";
import {
  type BrowseQuery,
  DEFAULT_WINDOW,
  parseSearchTerm,
  parseSort,
  parseWindow,
} from "~/plugins/links";
import "~/styles.css";

export const Route = createFileRoute("/{-$locale}/plugins/all")({
  validateSearch: (search: Record<string, unknown>): Omit<Partial<BrowseQuery>, "category"> => ({
    sort: parseSort(search.sort),
    window: parseWindow(search.window),
    q: parseSearchTerm(search.q),
  }),
  head: ({ params }) => {
    const locale = routeLocale(params);
    const t = getTranslator(locale);
    return pageMeta({
      title: t("plugins.meta.allTitle"),
      description: t("plugins.meta.allDescription"),
      path: "/plugins/all",
      locale,
    });
  },
  loader: () => getRegistry(),
  component: AllPluginsPage,
});

function AllPluginsPage() {
  const { plugins, installs, now } = Route.useLoaderData();
  const search = Route.useSearch();
  const query = useMemo<BrowseQuery>(
    () => ({
      sort: search.sort ?? "installs",
      window: search.window ?? DEFAULT_WINDOW,
      q: search.q,
    }),
    [search.sort, search.window, search.q],
  );
  return <BrowsePage plugins={plugins} installs={installs} now={now} query={query} />;
}
