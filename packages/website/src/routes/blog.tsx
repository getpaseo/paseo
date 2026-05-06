import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SiteShell } from "~/components/site-shell";

export const Route = createFileRoute("/blog")({
  component: BlogLayout,
});

function BlogLayout() {
  return (
    <SiteShell>
      <Outlet />
    </SiteShell>
  );
}
