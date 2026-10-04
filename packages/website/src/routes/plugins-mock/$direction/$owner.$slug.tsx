import { createFileRoute, notFound } from "@tanstack/react-router";
import { SiteShell } from "~/components/site-shell";
import { getRegistry, getRegistryPlugin } from "~/plugins";
import { DIRECTIONS } from "~/plugins-mock/directions";
import { type Direction, withMockData } from "~/plugins-mock/data";
import "~/styles.css";

export const Route = createFileRoute("/plugins-mock/$direction/$owner/$slug")({
  loader: async ({ params }) => {
    const [registry, plugin] = await Promise.all([
      getRegistry(),
      getRegistryPlugin({ data: `${params.owner}/${params.slug}` }),
    ]);
    if (!plugin) throw notFound();
    return { plugins: registry.plugins.map(withMockData), plugin: withMockData(plugin) };
  },
  component: MockDetail,
});

function MockDetail() {
  const { plugins, plugin } = Route.useLoaderData();
  const { direction } = Route.useParams();
  const { Detail } = DIRECTIONS[direction as Direction];
  return (
    <SiteShell width="default">
      <Detail plugin={plugin} plugins={plugins} />
    </SiteShell>
  );
}
