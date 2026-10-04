import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "~/components/site-shell";
import { getRegistry } from "~/plugins";
import { DIRECTIONS } from "~/plugins-mock/directions";
import { type Direction, withMockData } from "~/plugins-mock/data";
import "~/styles.css";

export const Route = createFileRoute("/plugins-mock/$direction/")({
  loader: async () => (await getRegistry()).plugins.map(withMockData),
  component: MockDirectory,
});

function MockDirectory() {
  const plugins = Route.useLoaderData();
  const { direction } = Route.useParams();
  const { Directory } = DIRECTIONS[direction as Direction];
  return (
    <SiteShell width="default">
      <Directory plugins={plugins} />
    </SiteShell>
  );
}
