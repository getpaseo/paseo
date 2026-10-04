import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "~/components/site-shell";
import { getRegistry } from "~/plugins";
import { DIRECTIONS } from "~/plugins-mock/directions";
import { type Direction, type MockSort, mockCategory, withMockData } from "~/plugins-mock/data";
import "~/styles.css";

interface ListSearch {
  category?: string;
  sort?: MockSort;
}

export const Route = createFileRoute("/plugins-mock/$direction/list")({
  validateSearch: (search: Record<string, unknown>): ListSearch => ({
    category:
      typeof search.category === "string" && mockCategory(search.category)
        ? search.category
        : undefined,
    sort: search.sort === "new" || search.sort === "installs" ? search.sort : undefined,
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
    <SiteShell width="default">
      <List plugins={plugins} category={search.category} sort={search.sort} />
    </SiteShell>
  );
}
