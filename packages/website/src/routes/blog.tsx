import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SiteHeader } from "~/components/site-header";

export const Route = createFileRoute("/blog")({
  component: BlogLayout,
});

function BlogLayout() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-prose mx-auto p-6 md:p-12">
        <div className="mb-8">
          <SiteHeader />
        </div>
        <Outlet />
      </div>
    </div>
  );
}
