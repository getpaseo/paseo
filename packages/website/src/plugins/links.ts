import type { CategorySlug } from "./categories";
import type { InstallWindow } from "./installs";

export const BUILD_URL = "/docs/plugins";
export const SUBMIT_URL =
  "https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml";

export type BrowseSort = "installs" | "new";
export interface BrowseQuery {
  /** Absent for all plugins. */
  category?: CategorySlug;
  sort: BrowseSort;
  window: InstallWindow;
  /** Search term; absent when not searching. */
  q?: string;
}

export const DEFAULT_WINDOW: InstallWindow = "week";

export function parseWindow(value: unknown): InstallWindow | undefined {
  return value === "month" || value === "all" ? value : undefined;
}
export function parseSearchTerm(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
export function parseSort(value: unknown): BrowseSort | undefined {
  return value === "new" ? value : undefined;
}

export function pluginHref(id: string): string {
  return `/plugins/${id}`;
}
export function categoryHref(category: CategorySlug): string {
  return `/plugins/category/${category}`;
}
export function browseHref({ category, sort, window, q }: BrowseQuery): string {
  const path = category ? categoryHref(category) : "/plugins/all";
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (sort === "new") params.set("sort", sort);
  else if (window !== DEFAULT_WINDOW) params.set("window", window);
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}
/** The directory's Most installed section in a time window. */
export function mostInstalledHref(window: InstallWindow): string {
  return `/plugins${window === DEFAULT_WINDOW ? "" : `?window=${window}`}#most-installed`;
}
