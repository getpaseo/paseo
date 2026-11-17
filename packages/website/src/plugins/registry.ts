import type { TFunction } from "i18next";
import type { z } from "zod";
import {
  isGitHubHost,
  parseGitHubRemoteIdentity,
  parseGitRemoteLocation,
} from "@getpaseo/protocol/git-remote";
import { pluginOverviewUrl } from "@getpaseo/protocol/plugin-overview";
import {
  pluginMediaKind,
  type PublishedPluginDetailSchema,
  type PublishedPluginSchema,
} from "@getpaseo/protocol/plugin-registry";
import { scoreTextFields } from "@getpaseo/protocol/search/text-match";
import { DEFAULT_LOCALE, type Locale } from "~/i18n";
import type { LocalizedMarkdown } from "~/markdown-content";
import { CATEGORIES, type CategorySlug } from "./categories";
import type { InstallCounts, InstallWindow } from "./installs";
export { CATEGORIES, type CategorySlug };
export type { InstallCounts, InstallWindow };
export type Plugin = z.infer<typeof PublishedPluginSchema>;
export type PluginDetail = z.infer<typeof PublishedPluginDetailSchema>;
/** What a plugin page and card say about the plugin, in the reader's language. */
export interface PluginListing {
  name: string;
  description: string;
}
export interface Author {
  username: string;
  name: string;
  github: string;
  npm?: string;
}
const DAY_MS = 24 * 60 * 60 * 1000;
export function getCategory(slug: string): CategorySlug | null {
  return CATEGORIES.find((category) => category === slug) ?? null;
}
/** The name and description in a language. Each field falls back to English on its own. */
export function pluginListing(plugin: Plugin, locale: Locale): PluginListing {
  const translation = plugin.translations?.[locale];
  return {
    name: translation?.name ?? plugin.name,
    description: translation?.description ?? plugin.description,
  };
}
/**
 * The overview in a language. Without a translation the whole English README is shown, never a mix
 * of the two.
 */
export function pluginOverview(plugin: PluginDetail, locale: Locale): LocalizedMarkdown {
  const translation = plugin.overviewTranslations?.[locale];
  return translation === undefined
    ? { raw: plugin.readme, locale: DEFAULT_LOCALE }
    : { raw: translation, locale };
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
  return `paseo plugin add ${plugin.id}`;
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
/** A new issue on the plugin's GitHub repository; absent when the source is hosted elsewhere. */
export function reportBugUrl(plugin: Plugin): string | undefined {
  const location = parseGitRemoteLocation(plugin.repository.url);
  if (!location || !isGitHubHost(location.host)) return undefined;
  // A monorepo source points at the plugin's folder; issues belong to the repository.
  const repository = parseGitHubRemoteIdentity(location.path.split("/").slice(0, 2).join("/"));
  return repository ? `https://github.com/${repository.repo}/issues/new` : undefined;
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
/**
 * Fields a search term can hit, best first: a name match outranks an author match, which outranks a
 * description match. Names and descriptions match in the reader's language and in English.
 */
function searchFieldGroups(plugin: Plugin, locale: Locale): string[][] {
  const author = getAuthor(plugin);
  const listing = pluginListing(plugin, locale);
  const name = [listing.name, plugin.name, plugin.id.split("/")[1]];
  const owner = [author.name, author.github, plugin.id];
  const description = [listing.description, plugin.description];
  return [name, owner, description, [...name, ...owner, ...description]];
}
interface SearchRank {
  field: number;
  tier: number;
}
function searchRank(plugin: Plugin, term: string, locale: Locale): SearchRank | null {
  const groups = searchFieldGroups(plugin, locale);
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
export function searchPlugins(plugins: Plugin[], term: string, locale: Locale): Plugin[] {
  if (!term.trim()) return plugins;
  return plugins
    .flatMap((plugin) => {
      const rank = searchRank(plugin, term, locale);
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
/**
 * Most recently listed first. A slow review does not push a plugin down, and an update does not
 * bring it back up. Equal times keep index order.
 */
export function newestFirst(plugins: Plugin[]): Plugin[] {
  return [...plugins].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}
/** Plugins with a version approved after their first listing, most recent update first. */
export function recentlyUpdated(plugins: Plugin[]): Plugin[] {
  return plugins
    .filter((plugin) => Date.parse(plugin.updatedAt) > Date.parse(plugin.publishedAt))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
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
export function addedAgo(plugin: Plugin, now: string, t: TFunction): string {
  return ago(plugin.publishedAt, now, t);
}
/** How long ago the plugin's current version was approved, relative to the loader's clock. */
export function updatedAgo(plugin: Plugin, now: string, t: TFunction): string {
  return ago(plugin.updatedAt, now, t);
}
function ago(date: string, now: string, t: TFunction): string {
  const days = Math.floor((Date.parse(now) - Date.parse(date)) / DAY_MS);
  if (days <= 0) return t("plugins.ago.today");
  if (days === 1) return t("plugins.ago.yesterday");
  if (days < 14) return t("plugins.ago.days", { count: days });
  return t("plugins.ago.weeks", { count: Math.round(days / 7) });
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
