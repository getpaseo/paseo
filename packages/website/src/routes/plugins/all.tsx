import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { pageMeta } from "~/meta";
import { getRegistry } from "~/plugins";
import { BrowsePage } from "~/plugins/browse-page";
import { type BrowseQuery, DEFAULT_WINDOW, parseSort, parseWindow } from "~/plugins/links";
import "~/styles.css";

export const Route = createFileRoute("/plugins/all")({
  validateSearch: (search: Record<string, unknown>): Omit<Partial<BrowseQuery>, "category"> => ({
    sort: parseSort(search.sort),
    window: parseWindow(search.window),
  }),
  head: () =>
    pageMeta(
      "All plugins – Paseo plugins",
      "Every community plugin for Paseo, by installs or newest first.",
      "/plugins/all",
    ),
  loader: () => getRegistry(),
  component: AllPluginsPage,
});

function AllPluginsPage() {
  const { plugins, installs, now } = Route.useLoaderData();
  const search = Route.useSearch();
  const query = useMemo<BrowseQuery>(
    () => ({ sort: search.sort ?? "installs", window: search.window ?? DEFAULT_WINDOW }),
    [search.sort, search.window],
  );
  return <BrowsePage plugins={plugins} installs={installs} now={now} query={query} />;
}
