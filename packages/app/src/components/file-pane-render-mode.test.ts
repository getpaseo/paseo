import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "@getpaseo/protocol/plugin/types";
import {
  isRenderedMarkdownFile,
  pluginFilePreviewConflicts,
  pluginFilePreviewsForPath,
  resolveFilePreviewRenderer,
} from "@/components/file-pane-render-mode";

function installedPlugin(input: {
  id: string;
  extensions: string[];
  enabled?: boolean;
  unavailableReason?: string | null;
  title?: string;
}): InstalledPlugin {
  return {
    manifest: {
      id: input.id,
      name: `${input.id} plugin`,
      version: "1.0.0",
      contributes: {
        filePreviews: [
          {
            id: "table",
            title: input.title ?? "Table",
            extensions: input.extensions,
            entry: "preview.html",
          },
        ],
      },
    },
    enabled: input.enabled ?? true,
    installedAt: "2026-02-05T00:00:00.000Z",
    source: { kind: "local" },
    unavailableReason: input.unavailableReason ?? null,
  };
}

describe("isRenderedMarkdownFile", () => {
  it("detects .md files", () => {
    expect(isRenderedMarkdownFile("README.md")).toBe(true);
    expect(isRenderedMarkdownFile("docs/guide.MD")).toBe(true);
  });

  it("detects .markdown files", () => {
    expect(isRenderedMarkdownFile("notes.markdown")).toBe(true);
    expect(isRenderedMarkdownFile("docs/CHANGELOG.MARKDOWN")).toBe(true);
  });

  it("does not treat .mdx files as rendered markdown", () => {
    expect(isRenderedMarkdownFile("page.mdx")).toBe(false);
  });

  it("does not treat other text files as rendered markdown", () => {
    expect(isRenderedMarkdownFile("src/index.ts")).toBe(false);
    expect(isRenderedMarkdownFile("README.md.txt")).toBe(false);
  });
});

describe("resolveFilePreviewRenderer", () => {
  it("falls back to the built-in views when no plugin claims the extension", () => {
    const plugins = [installedPlugin({ id: "csv-table", extensions: [".csv"] })];

    expect(resolveFilePreviewRenderer({ filePath: "/w/README.md", plugins })).toEqual({
      kind: "markdown",
    });
    expect(resolveFilePreviewRenderer({ filePath: "/w/index.ts", plugins })).toEqual({
      kind: "code",
    });
  });

  it("prefers a plugin preview over the built-in markdown view", () => {
    const plugins = [installedPlugin({ id: "fancy-md", extensions: [".md"] })];

    expect(resolveFilePreviewRenderer({ filePath: "/w/README.md", plugins })).toEqual({
      kind: "plugin",
      pluginId: "fancy-md",
      pluginName: "fancy-md plugin",
      contributionId: "table",
      title: "Table",
      entry: "preview.html",
    });
  });

  it("breaks a tie between two plugins alphabetically by plugin id", () => {
    const plugins = [
      installedPlugin({ id: "zeta-view", extensions: [".csv"] }),
      installedPlugin({ id: "alpha-view", extensions: [".csv"] }),
    ];

    expect(resolveFilePreviewRenderer({ filePath: "/w/data.csv", plugins })).toMatchObject({
      kind: "plugin",
      pluginId: "alpha-view",
    });
    expect(
      pluginFilePreviewsForPath({ filePath: "/w/data.csv", plugins }).map((p) => p.pluginId),
    ).toEqual(["alpha-view", "zeta-view"]);
  });

  it("ignores disabled and unavailable plugins", () => {
    const plugins = [
      installedPlugin({ id: "alpha-view", extensions: [".csv"], enabled: false }),
      installedPlugin({
        id: "beta-view",
        extensions: [".csv"],
        unavailableReason: "Requires Paseo >= 9.0.0",
      }),
      installedPlugin({ id: "gamma-view", extensions: [".csv"] }),
    ];

    expect(resolveFilePreviewRenderer({ filePath: "/w/data.csv", plugins })).toMatchObject({
      pluginId: "gamma-view",
    });
  });

  // The title reaches a segmented control that neither wraps nor scrolls, and
  // nothing upstream bounds what a plugin author puts there.
  it("truncates a plugin title that would run off the toolbar", () => {
    const plugins = [installedPlugin({ id: "loud", extensions: [".csv"], title: "T".repeat(400) })];
    const renderer = resolveFilePreviewRenderer({ filePath: "data.csv", plugins });
    expect(renderer.kind).toBe("plugin");
    expect(renderer.kind === "plugin" && renderer.title.length).toBe(24);
  });

  it("matches extensions case-insensitively and honours multi-dot extensions", () => {
    const plugins = [installedPlugin({ id: "tar-view", extensions: [".tar.gz"] })];

    expect(resolveFilePreviewRenderer({ filePath: "/w/Archive.TAR.GZ", plugins })).toMatchObject({
      pluginId: "tar-view",
    });
    expect(resolveFilePreviewRenderer({ filePath: "/w/archive.gz", plugins })).toEqual({
      kind: "code",
    });
  });
});

describe("pluginFilePreviewConflicts", () => {
  it("reports the losing plugin for each contested extension", () => {
    const plugins = [
      installedPlugin({ id: "zeta-view", extensions: [".csv", ".tsv"] }),
      installedPlugin({ id: "alpha-view", extensions: [".csv"] }),
    ];

    expect(pluginFilePreviewConflicts(plugins)).toEqual([
      { extension: ".csv", winnerPluginId: "alpha-view", losingPluginIds: ["zeta-view"] },
    ]);
  });

  it("does not report a plugin as conflicting with itself", () => {
    const plugins: InstalledPlugin[] = [
      {
        manifest: {
          id: "csv-table",
          name: "CSV Table",
          version: "1.0.0",
          contributes: {
            filePreviews: [
              { id: "table", title: "Table", extensions: [".csv"], entry: "table.html" },
              { id: "chart", title: "Chart", extensions: [".csv"], entry: "chart.html" },
            ],
          },
        },
        enabled: true,
        installedAt: "2026-02-05T00:00:00.000Z",
        source: { kind: "local" },
        unavailableReason: null,
      },
    ];

    expect(pluginFilePreviewConflicts(plugins)).toEqual([]);
  });

  it("reports nothing when the only other claimant is disabled", () => {
    const plugins = [
      installedPlugin({ id: "zeta-view", extensions: [".csv"] }),
      installedPlugin({ id: "alpha-view", extensions: [".csv"], enabled: false }),
    ];

    expect(pluginFilePreviewConflicts(plugins)).toEqual([]);
  });
});
