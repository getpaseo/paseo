import { Link } from "@tanstack/react-router";
import { Breadcrumbs } from "~/components/breadcrumbs";
import { SiteShell } from "~/components/site-shell";

const NOT_FOUND_CRUMBS = [{ label: "Plugins", href: "/plugins" }, { label: "Not found" }];

export function PluginsNotFound({ title, children }: { title: string; children: string }) {
  return (
    <SiteShell width="default">
      <Breadcrumbs items={NOT_FOUND_CRUMBS} />
      <h1 className="text-3xl font-medium tracking-tight mb-4">{title}</h1>
      <p className="text-lg text-white/70 leading-relaxed max-w-2xl">
        {children}{" "}
        <Link to="/plugins" className="underline hover:text-white">
          Browse all plugins
        </Link>
        .
      </p>
    </SiteShell>
  );
}
