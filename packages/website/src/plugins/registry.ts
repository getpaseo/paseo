import type { z } from "zod";
import type { PublishedPluginSchema } from "@getpaseo/protocol/plugin-registry";
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
/** Newest submissions first; equal dates keep index order. */
export function newestFirst(plugins: Plugin[]): Plugin[] {
  return [...plugins].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
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
/** How long ago the registry accepted the plugin, relative to the loader's clock. */
export function addedAgo(plugin: Plugin, now: string): string {
  const days = Math.floor((Date.parse(now) - Date.parse(plugin.submittedAt)) / DAY_MS);
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
