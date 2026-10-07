import type { z } from "zod";
import { pluginOverviewUrl } from "@getpaseo/protocol/plugin-overview";
import { pluginMediaKind, type PublishedPluginSchema } from "@getpaseo/protocol/plugin-registry";
import { scoreTextFields } from "@getpaseo/protocol/search/text-match";
import { CATEGORIES, type Category, type CategorySlug } from "./categories";
import type { InstallCounts, InstallWindow } from "./installs";
export { CATEGORIES, type Category, type CategorySlug };
export type { InstallCounts, InstallWindow };
export type Plugin = z.infer<typeof PublishedPluginSchema>;
export interface Author {
  username: string;
  name: string;
  github: string;
  npm?: string;
}
const DAY_MS = 24 * 60 * 60 * 1000;
export function getCategory(slug: string): Category | null {
  return CATEGORIES.find((category) => category.slug === slug) ?? null;
}
/** The plugin's first HTTPS image, for cards and link previews; videos never stand in for one. */
export function firstMediaImage(plugin: Plugin): string | undefined {
  return plugin.media.find((url) => pluginOverviewUrl(url) && pluginMediaKind(url) === "image");
}
export function getPluginsInCategory(plugins: Plugin[], slug: string): Plugin[] {
  return plugins.filter((plugin) => plugin.categories.includes(slug));
}
/** The namespace segment of the plugin ID. It is the route param for the plugin and its author. */
export function pluginOwner(plugin: Plugin): string {
  return plugin.id.split("/")[0];
}
export function getAuthor(plugin: Plugin): Author {
  const { author } = plugin;
  return {
    username: pluginOwner(plugin),
    github: author.github,
    name: author.name ?? author.github,
    npm: author.npm,
  };
}
export function getPluginsByAuthor(plugins: Plugin[], owner: string): Plugin[] {
  return plugins.filter((plugin) => pluginOwner(plugin) === owner);
}
export function installCommand(plugin: Plugin): string {
  return `paseo plugin install ${plugin.id}`;
}
export function pluginVersion(plugin: Plugin): string {
  return plugin.artifact.kind === "npm"
    ? plugin.artifact.version
    : plugin.artifact.commit.slice(0, 12);
}
export function npmUrl(plugin: Plugin): string | undefined {
  return plugin.artifact.kind === "npm"
    ? `https://www.npmjs.com/package/${plugin.artifact.package}`
    : undefined;
}
export function authorNpmUrl(author: Author): string | undefined {
  return author.npm ? `https://www.npmjs.com/~${author.npm}` : undefined;
}
export function authorGitHubUrl(author: Author): string {
  return `https://github.com/${author.github}`;
}
export function authorAvatarUrl(author: Author): string {
  return `https://github.com/${author.github}.png?size=80`;
}
export function formatInstalls(count: number): string {
  if (count < 1000) return String(count);
  const k = count / 1000;
  return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
}
/** Fields a search term can hit, best first: a name match outranks an author match, which outranks a description match. */
function searchFieldGroups(plugin: Plugin): string[][] {
  const author = getAuthor(plugin);
  const name = [plugin.name, plugin.id.split("/")[1]];
  const owner = [author.name, author.github, plugin.id];
  return [name, owner, [plugin.description], [...name, ...owner, plugin.description]];
}
interface SearchRank {
  field: number;
  tier: number;
}
function searchRank(plugin: Plugin, term: string): SearchRank | null {
  const groups = searchFieldGroups(plugin);
  for (let field = 0; field < groups.length; field += 1) {
    const score = scoreTextFields(term, groups[field], { subsequence: false });
    if (score) return { field, tier: score.tier };
  }
  return null;
}
/**
 * Plugins whose name, author, ID, or description contains every word of the term, ignoring case.
 * Name matches come first, then author, then description; within each, exact words beat partial
 * ones, and equal matches keep the given order.
 */
export function searchPlugins(plugins: Plugin[], term: string): Plugin[] {
  if (!term.trim()) return plugins;
  return plugins
    .flatMap((plugin) => {
      const rank = searchRank(plugin, term);
      return rank ? [{ plugin, rank }] : [];
    })
    .sort((a, b) => a.rank.field - b.rank.field || a.rank.tier - b.rank.tier)
    .map(({ plugin }) => plugin);
}
/** The featured IDs that name a listed plugin, in the registry's order, each once. */
export function featuredPlugins(plugins: Plugin[], featured: string[]): Plugin[] {
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  return [...new Set(featured)].flatMap((id) => byId.get(id) ?? []);
}
/** Most recently listed first; equal dates keep index order. */
export function newestFirst(plugins: Plugin[]): Plugin[] {
  return [...plugins].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}
/** Most installs in the window first; equal counts keep index order. */
export function mostInstalled(
  plugins: Plugin[],
  installs: Record<string, InstallCounts>,
  window: InstallWindow,
): Plugin[] {
  const count = (plugin: Plugin) => installs[plugin.id]?.[window] ?? 0;
  return [...plugins].sort((a, b) => count(b) - count(a));
}
/** How long ago the plugin was first listed, relative to the loader's clock. */
export function addedAgo(plugin: Plugin, now: string): string {
  const days = Math.floor((Date.parse(now) - Date.parse(plugin.publishedAt)) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days}d ago`;
  return `${Math.round(days / 7)}w ago`;
}
/**
 * A README usually opens with the plugin's name and quoted description; the page shows both.
 * A leading GitHub alert (`> [!WARNING]`) is a note for the reader and stays.
 */
export function readmeBody(readme: string): string {
  return readme
    .replace(/^\s*#\s[^\n]*\n+/, "")
    .replace(/^(?!>\s*\[!)(>[^\n]*\n)+\n*/, "")
    .trimStart();
}
