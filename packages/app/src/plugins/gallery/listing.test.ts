import { describe, expect, it } from "vitest";
import type { PluginListingIndex, PluginListing } from "@getpaseo/protocol/plugin-registry";
import {
  ALL_CATEGORIES,
  featuredListings,
  filterDirectory,
  formatInstallCount,
  listingImages,
  listingText,
} from "./listing";

function listing(id: string, overrides: Partial<PluginListing> = {}): PluginListing {
  return {
    id,
    name: id.split("/")[1] ?? id,
    description: `${id} description`,
    categories: [],
    author: { github: id.split("/")[0] ?? id },
    repository: { url: `https://github.com/${id}` },
    artifact: { kind: "git", remote: `https://github.com/${id}.git`, commit: "a".repeat(40) },
    media: [],
    submittedAt: "2026-01-01T00:00:00Z",
    reviewedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    publishedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as PluginListing;
}

function directory(plugins: PluginListing[], featured: string[] = []): PluginListingIndex {
  return {
    schemaVersion: 1,
    registry: { name: "Paseo", url: "https://plugins.paseo.sh" },
    categories: [{ slug: "git", label: "Git" }],
    plugins,
    featured,
    generatedAt: "2026-01-01T00:00:00Z",
  };
}

const ids = (listings: PluginListing[]) => listings.map((entry) => entry.id);

describe("filterDirectory", () => {
  const index = directory([
    listing("acme/zeta", { installs: 5, updatedAt: "2026-03-01T00:00:00Z", categories: ["git"] }),
    listing("acme/alpha", { installs: 50, updatedAt: "2026-01-01T00:00:00Z" }),
    listing("other/beta", {
      updatedAt: "2026-02-01T00:00:00Z",
      translations: { fr: { name: "Bêta", description: "Revue de code" } },
    }),
  ]);

  it("orders by installs, recency or name", () => {
    const all = { query: "", category: ALL_CATEGORIES };
    expect(ids(filterDirectory(index, { ...all, sort: "popular" }, "en"))).toEqual([
      "acme/alpha",
      "acme/zeta",
      "other/beta",
    ]);
    expect(ids(filterDirectory(index, { ...all, sort: "recent" }, "en"))).toEqual([
      "acme/zeta",
      "other/beta",
      "acme/alpha",
    ]);
    expect(ids(filterDirectory(index, { ...all, sort: "name" }, "en"))).toEqual([
      "acme/alpha",
      "other/beta",
      "acme/zeta",
    ]);
  });

  it("keeps only the chosen category", () => {
    expect(
      ids(filterDirectory(index, { query: "", category: "git", sort: "popular" }, "en")),
    ).toEqual(["acme/zeta"]);
  });

  it("matches the query against the author and the reader's translation", () => {
    const search = (query: string, language: string) =>
      ids(filterDirectory(index, { query, category: ALL_CATEGORIES, sort: "name" }, language));
    expect(search("  ACME ", "en")).toEqual(["acme/alpha", "acme/zeta"]);
    expect(search("revue", "fr-CA")).toEqual(["other/beta"]);
    expect(search("revue", "en")).toEqual([]);
  });
});

describe("listing presentation", () => {
  it("falls back from a regional language to its base translation, then English", () => {
    const entry = listing("other/beta", { translations: { fr: { name: "Bêta" } } });
    expect(listingText(entry, "fr-CA")).toEqual({
      name: "Bêta",
      description: "other/beta description",
    });
    expect(listingText(entry, "ja").name).toBe("beta");
  });

  it("formats install counts compactly", () => {
    expect([999, 1000, 1149, 9950, 12_400].map(formatInstallCount)).toEqual([
      "999",
      "1k",
      "1.1k",
      "9.9k",
      "12k",
    ]);
  });

  it("shows images and leaves videos out", () => {
    const entry = listing("acme/alpha", {
      media: ["https://cdn.test/a.png", "https://cdn.test/demo.mp4", "https://cdn.test/b.webp"],
    });
    expect(listingImages(entry)).toEqual(["https://cdn.test/a.png", "https://cdn.test/b.webp"]);
  });

  it("features listed plugins in the maintainer's order and skips unlisted ones", () => {
    const index = directory(
      [listing("acme/alpha"), listing("acme/zeta")],
      ["acme/zeta", "gone/plugin", "acme/alpha"],
    );
    expect(ids(featuredListings(index))).toEqual(["acme/zeta", "acme/alpha"]);
  });
});
