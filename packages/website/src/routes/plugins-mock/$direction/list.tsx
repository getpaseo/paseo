import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "~/components/site-shell";
import { getRegistry } from "~/plugins";
import { DIRECTIONS } from "~/plugins-mock/directions";
import { type Direction, type MockLayout,
  type MockSort,
  type MockWindow, mockCategory, withMockData } from "~/plugins-mock/data";
import "~/styles.css";

interface ListSearch {
  category?: string;
  sort?: MockSort;
  window?: MockWindow;
  layout?: MockLayout;
}

export const Route = createFileRoute("/plugins-mock/$direction/list")({
  validateSearch: (search: Record<string, unknown>): ListSearch => ({
    category:
      typeof search.category === "string" && mockCategory(search.category)
        ? search.category
        : undefined,
    sort: search.sort === "new" || search.sort === "installs" ? search.sort : undefined,
    window: search.window === "month" || search.window === "all" ? search.window : undefined,
    layout: search.layout === "horizontal" ? "horizontal" : undefined,
  }),
  loader: async () => (await getRegistry()).plugins.map(withMockData),
  component: MockList,
});

function MockList() {
  const plugins = Route.useLoaderData();
  const search = Route.useSearch();
  const { direction } = Route.useParams();
  const { List } = DIRECTIONS[direction as Direction];
  return (
    <SiteShell width={direction === "final" ? "wide" : "default"}>
      <List
        plugins={plugins}
        category={search.category}
        sort={search.sort}
        window={search.window}
        layout={search.layout}
      />
    </SiteShell>
  );
}
