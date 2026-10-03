import type { z } from "zod";
import type { PublishedPluginSchema } from "@getpaseo/protocol/plugin-registry";
import { CATEGORIES, type Category, type CategorySlug } from "./categories";
export { CATEGORIES, type Category, type CategorySlug };
export type Plugin = z.infer<typeof PublishedPluginSchema>;
export interface Author {
  username: string;
  name: string;
  github: string;
  npm?: string;
}
export type PluginSort = "popular" | "new";
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
export function pinnedInstallCommand(plugin: Plugin): string {
  const artifact = plugin.artifact;
  if (artifact.kind === "npm")
    return `paseo plugin install npm:${artifact.package}@${artifact.version}`;
  const source = artifact.remote
    .replace(/^https:\/\/github.com\//, "github:")
    .replace(/\.git$/, "");
  const location = artifact.pluginPath ? `${source}:${artifact.pluginPath}` : source;
  return `paseo plugin install ${location} --ref ${artifact.commit}`;
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
export interface PluginQuery {
  category?: CategorySlug;
  q?: string;
  sort: PluginSort;
}
export function queryPlugins(plugins: Plugin[], query: PluginQuery): Plugin[] {
  const needle = query.q?.trim().toLowerCase() ?? "";
  const matches = plugins.filter(
    (plugin) =>
      (!query.category || plugin.categories.includes(query.category)) &&
      (!needle ||
        `${plugin.name} ${plugin.description} ${plugin.id}`.toLowerCase().includes(needle)),
  );
  return sortPlugins(matches, query.sort);
}
export function sortPlugins(list: Plugin[], sort: PluginSort): Plugin[] {
  return [...list].sort(
    (a, b) =>
      (sort === "new"
        ? b.updatedAt.localeCompare(a.updatedAt)
        : (b.installs ?? 0) - (a.installs ?? 0)) || a.name.localeCompare(b.name),
  );
}
