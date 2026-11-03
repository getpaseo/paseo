/** Category slugs in display order. Labels and descriptions are site copy under `plugins.categories`. */
export const CATEGORIES = [
  "daemon-management",
  "themes",
  "providers",
  "orchestration",
  "git",
  "workspaces",
  "sidebar",
  "extras",
  "utils",
] as const;

export type CategorySlug = (typeof CATEGORIES)[number];
