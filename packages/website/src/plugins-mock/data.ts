// Design mockup data. The live registry still has the old categories and flat dates/installs,
// so this layer pins the nine new categories and fakes "added" dates and install counts.
import {
  Blocks,
  Boxes,
  GitBranch,
  LayoutPanelLeft,
  type LucideIcon,
  Network,
  Palette,
  Server,
  Sparkles,
  Wrench,
} from "lucide-react";
import type { Plugin } from "~/plugins";

export const MOCK_CATEGORIES = [
  { slug: "daemon-management", label: "Daemon management", icon: Server },
  { slug: "themes", label: "Themes", icon: Palette },
  { slug: "providers", label: "Providers", icon: Boxes },
  { slug: "orchestration", label: "Orchestration", icon: Network },
  { slug: "git", label: "Git", icon: GitBranch },
  { slug: "workspaces", label: "Workspaces", icon: Blocks },
  { slug: "sidebar", label: "Sidebar", icon: LayoutPanelLeft },
  { slug: "extras", label: "Extras", icon: Sparkles },
  { slug: "utils", label: "Utils", icon: Wrench },
] as const satisfies readonly { slug: string; label: string; icon: LucideIcon }[];

export type MockCategory = (typeof MOCK_CATEGORIES)[number];
export type MockCategorySlug = MockCategory["slug"];

interface Override {
  categories: MockCategorySlug[];
  daysAgo: number;
  installs: number;
  /** Faked installs in the last 7 and 30 days, so the time window visibly reorders the list. */
  week?: number;
  month?: number;
}

const OVERRIDES: Record<string, Override> = {
  "alhassanaraouf/base2tone": { categories: ["themes"], daysAgo: 1, installs: 38, week: 31, month: 38 },
  "dorasto/sayr": { categories: ["sidebar"], daysAgo: 2, installs: 21, week: 19, month: 21 },
  "gpambrozio/github-board": { categories: ["git", "sidebar"], daysAgo: 3, installs: 412, week: 164, month: 388 },
  "gpambrozio/herald": { categories: ["extras"], daysAgo: 5, installs: 267, week: 97, month: 251 },
  "gpambrozio/launchd-jobs": { categories: ["daemon-management"], daysAgo: 6, installs: 95, week: 22, month: 80 },
  "gpambrozio/model-pricing": { categories: ["sidebar"], daysAgo: 9, installs: 640, week: 58, month: 410 },
  "gpambrozio/skills": { categories: ["utils"], daysAgo: 11, installs: 188, week: 12, month: 140 },
  "hungcuong9125/prompt-kit": { categories: ["extras"], daysAgo: 4, installs: 74, week: 66, month: 74 },
  "omercnet/agent-monitor": { categories: ["orchestration"], daysAgo: 14, installs: 1240, week: 41, month: 520 },
  "omercnet/beads": { categories: ["workspaces"], daysAgo: 16, installs: 356, week: 9, month: 190 },
  "omercnet/dracula": { categories: ["themes"], daysAgo: 30, installs: 2310, week: 35, month: 310 },
  "omercnet/fresh-worktrees": { categories: ["git", "workspaces"], daysAgo: 21, installs: 870, week: 18, month: 240 },
  "omercnet/omp": { categories: ["providers"], daysAgo: 24, installs: 530, week: 6, month: 95 },
  "omercnet/pr-radar": { categories: ["git", "orchestration"], daysAgo: 19, installs: 702, week: 27, month: 330 },
  "omercnet/shared-browser": { categories: ["workspaces"], daysAgo: 12, installs: 1580, week: 73, month: 640 },
  "omercnet/tell-agent": { categories: ["orchestration"], daysAgo: 8, installs: 310, week: 88, month: 295 },
  "tomgrin10/defer": { categories: ["utils"], daysAgo: 7, installs: 455, week: 52, month: 302 },
  "tomgrin10/graphite": { categories: ["git"], daysAgo: 26, installs: 980, week: 14, month: 170 },
};

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

export type MockWindow = "week" | "month" | "all";

export const MOCK_WINDOWS: { value: MockWindow; label: string }[] = [
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "all", label: "All time" },
];

export type MockPlugin = Plugin & {
  categories: MockCategorySlug[];
  addedAt: string;
  installsIn: Record<MockWindow, number>;
};

export function withMockData<T extends Plugin>(plugin: T): T & MockPlugin {
  const override = OVERRIDES[plugin.id] ?? { categories: ["utils"], daysAgo: 40, installs: 0 };
  return {
    ...plugin,
    categories: override.categories,
    installs: override.installs,
    addedAt: new Date(NOW - override.daysAgo * DAY).toISOString(),
    installsIn: {
      week: override.week ?? 0,
      month: override.month ?? 0,
      all: override.installs,
    },
  };
}

export function mockCategory(slug: string): MockCategory | null {
  return MOCK_CATEGORIES.find((category) => category.slug === slug) ?? null;
}

export function inCategory(plugins: MockPlugin[], slug: string): MockPlugin[] {
  return plugins.filter((plugin) => (plugin.categories as string[]).includes(slug));
}

export type MockSort = "new" | "installs";

export function sortBy(plugins: MockPlugin[], sort: MockSort): MockPlugin[] {
  return [...plugins].sort((a, b) =>
    sort === "new"
      ? b.addedAt.localeCompare(a.addedAt)
      : (b.installs ?? 0) - (a.installs ?? 0) || a.name.localeCompare(b.name),
  );
}

export function sortByInstalls(plugins: MockPlugin[], window: MockWindow): MockPlugin[] {
  return [...plugins].sort(
    (a, b) => b.installsIn[window] - a.installsIn[window] || a.name.localeCompare(b.name),
  );
}

export function addedAgo(plugin: MockPlugin): string {
  const days = Math.round((NOW - Date.parse(plugin.addedAt)) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days}d ago`;
  return `${Math.round(days / 7)}w ago`;
}

/** A plugin's README usually opens with its name and description; the page already shows both. */
export function readmeBody(readme: string): string {
  return readme
    .replace(/^\s*#\s[^\n]*\n+/, "")
    .replace(/^(>[^\n]*\n)+\n*/, "")
    .trimStart();
}

export const SUBMIT_URL = "https://github.com/getpaseo/plugins";
export const BUILD_URL = "/docs/plugins";

export type Direction = "a" | "b" | "c" | "d" | "final";
export type MockLayout = "stacked" | "horizontal";

export function pluginHref(direction: Direction, plugin: Plugin): string {
  return `/plugins-mock/${direction}/${plugin.id}`;
}

export function listHref(
  direction: Direction,
  query: { category?: string; sort?: MockSort; window?: MockWindow; layout?: MockLayout },
): string {
  const params = new URLSearchParams();
  if (query.category) params.set("category", query.category);
  if (query.sort) params.set("sort", query.sort);
  if (query.window && query.window !== "week") params.set("window", query.window);
  if (query.layout && query.layout !== "stacked") params.set("layout", query.layout);
  const qs = params.toString();
  return `/plugins-mock/${direction}/list${qs ? `?${qs}` : ""}`;
}
