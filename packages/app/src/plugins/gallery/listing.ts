import type { PluginListItem } from "@getpaseo/protocol/messages";
import {
  pluginMediaKind,
  type PluginListingIndex,
  type PluginListing,
} from "@getpaseo/protocol/plugin-registry";

export type DirectorySort = "popular" | "recent" | "name";
export const ALL_CATEGORIES = "all";

export interface DirectoryFilter {
  query: string;
  category: string;
  sort: DirectorySort;
}

/** The listing's name and description in the reader's language, falling back to English. */
export function listingText(listing: PluginListing, language: string) {
  const translation = listing.translations?.[language] ?? listing.translations?.[baseTag(language)];
  return {
    name: translation?.name ?? listing.name,
    description: translation?.description ?? listing.description,
  };
}

function baseTag(language: string): string {
  return language.split("-")[0] ?? language;
}

export function listingAuthor(listing: PluginListing): string {
  return listing.author.name ?? listing.author.github;
}

/** The author's GitHub avatar, the same picture the website shows. */
export function listingAuthorAvatar(listing: PluginListing): string {
  return `https://github.com/${encodeURIComponent(listing.author.github)}.png?size=40`;
}

/** The version a listing pins: the npm version, or the short Git commit. */
export function listingVersion(listing: PluginListing): string | undefined {
  return listing.artifact.version ?? listing.artifact.commit?.slice(0, 7);
}

/** Where a listing's code comes from: the npm package, or the repository. */
export function listingSource(listing: PluginListing): string {
  return listing.artifact.package ?? listing.repository.url;
}

/** Image media in display order. Videos are left to the website. */
export function listingImages(listing: PluginListing): string[] {
  return listing.media.filter((url) => pluginMediaKind(url) === "image");
}

/** "1.1k" style counts: one decimal below ten thousand, whole thousands above. */
export function formatInstallCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(count / 1000)}k`;
}

/** The registry listing an installed plugin came from, if it came from one. */
export function installedListingId(plugin: PluginListItem): string | undefined {
  const identity = plugin.installation?.identity;
  if (!identity || identity.kind === "directory") return undefined;
  return identity.registry?.id;
}

/** Installed plugins by the listing they came from. */
export function installedByListing(plugins: readonly PluginListItem[]) {
  const byListing = new Map<string, PluginListItem>();
  for (const plugin of plugins) {
    const listingId = installedListingId(plugin);
    if (listingId) byListing.set(listingId, plugin);
  }
  return byListing;
}

function matches(listing: PluginListing, language: string, query: string): boolean {
  if (!query) return true;
  const { name, description } = listingText(listing, language);
  const haystack = [name, description, listing.id, listingAuthor(listing)].join("\n").toLowerCase();
  return haystack.includes(query);
}

const SORTS: Record<DirectorySort, (left: PluginListing, right: PluginListing) => number> = {
  popular: (left, right) => (right.installs ?? 0) - (left.installs ?? 0),
  recent: (left, right) => right.updatedAt.localeCompare(left.updatedAt),
  name: (left, right) => left.name.localeCompare(right.name),
};

/** The directory's listings that pass the filter, in the chosen order. */
export function filterDirectory(
  index: PluginListingIndex,
  filter: DirectoryFilter,
  language: string,
): PluginListing[] {
  const query = filter.query.trim().toLowerCase();
  return index.plugins
    .filter(
      (listing) =>
        (filter.category === ALL_CATEGORIES || listing.categories.includes(filter.category)) &&
        matches(listing, language, query),
    )
    .sort(SORTS[filter.sort]);
}

/** Featured listings that exist, in the maintainer's order. */
export function featuredListings(index: PluginListingIndex): PluginListing[] {
  const byId = new Map(index.plugins.map((listing) => [listing.id, listing]));
  return index.featured.flatMap((id) => byId.get(id) ?? []);
}

export function categoryLabel(index: PluginListingIndex, slug: string): string {
  return index.categories.find((category) => category.slug === slug)?.label ?? slug;
}
