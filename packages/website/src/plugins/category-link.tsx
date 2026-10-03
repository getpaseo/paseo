import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo } from "react";
import type { CategorySlug, PluginSort } from "./registry";

interface CategoryLinkProps {
  /** `null` links to the unfiltered list. */
  category: CategorySlug | null;
  q?: string;
  sort?: PluginSort;
  replace?: boolean;
  className?: string;
  children: ReactNode;
}

/** Link into the plugin list filtered by category, keeping any search and sort. */
export function CategoryLink({
  category,
  q,
  sort,
  replace,
  className,
  children,
}: CategoryLinkProps) {
  const search = useMemo(() => {
    const next: { category?: CategorySlug; q?: string; sort?: PluginSort } = {};
    if (category) next.category = category;
    if (q) next.q = q;
    if (sort === "new") next.sort = sort;
    return next;
  }, [category, q, sort]);
  return (
    <Link to="/plugins" search={search} replace={replace} className={className}>
      {children}
    </Link>
  );
}
