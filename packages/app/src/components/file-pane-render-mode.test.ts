import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "@getpaseo/protocol/plugin/types";
import {
  filePreviewRenderKind,
  isRenderedMarkdownFile,
  pluginFilePreviewConflicts,
  pluginFilePreviewsForPath,
  resolveFilePreviewRenderer,
  resolveFilePreviewRendererGated,
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
    expect(isRenderedMarkdownFile("plan.html")).toBe(false);
  });
});

describe("filePreviewRenderKind", () => {
  it("maps each renderable extension to its kind", () => {
    expect(filePreviewRenderKind("README.md")).toBe("markdown");
    expect(filePreviewRenderKind("notes.markdown")).toBe("markdown");
    expect(filePreviewRenderKind("plan.html")).toBe("html");
    expect(filePreviewRenderKind("docs/PLAN.HTML")).toBe("html");
    expect(filePreviewRenderKind("plan.htm")).toBe("html");
  });

  it("returns null for files without a rendered preview", () => {
    expect(filePreviewRenderKind("src/index.ts")).toBe(null);
    expect(filePreviewRenderKind("page.mdx")).toBe(null);
    expect(filePreviewRenderKind("index.html.erb")).toBe(null);
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

  // A built-in outranks every plugin, so the extensions core already renders are
  // closed to plugins. The pane and the Settings conflict report have to agree on
  // that or Settings names a winner the pane never shows, which is why both are
  // asserted here rather than only the renderer.
  it("keeps the built-in views ahead of a plugin claiming the same extension", () => {
    const markdown = [installedPlugin({ id: "fancy-md", extensions: [".md"] })];
    const html = [installedPlugin({ id: "fancy-html", extensions: [".html"] })];

    expect(resolveFilePreviewRenderer({ filePath: "/w/README.md", plugins: markdown })).toEqual({
      kind: "markdown",
    });
    expect(resolveFilePreviewRenderer({ filePath: "/w/page.html", plugins: html })).toEqual({
      kind: "html",
    });
    expect(pluginFilePreviewsForPath({ filePath: "/w/README.md", plugins: markdown })).toEqual([]);
    expect(pluginFilePreviewsForPath({ filePath: "/w/page.html", plugins: html })).toEqual([]);
  });

  it("renders an extension core does not claim through the plugin", () => {
    const plugins = [installedPlugin({ id: "csv-view", extensions: [".csv"] })];

    expect(resolveFilePreviewRenderer({ filePath: "/w/data.csv", plugins })).toEqual({
      kind: "plugin",
      pluginId: "csv-view",
      pluginName: "csv-view plugin",
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

describe("resolveFilePreviewRendererGated", () => {
  const plugins = [installedPlugin({ id: "csv", extensions: [".csv"] })];

  // The regression this exists for: a file with no workspace-relative path is
  // ineligible for plugins, and gating the whole decision on that took the
  // built-in markdown view away from every `~/notes.md` in the file explorer.
  it("still renders markdown for a file no plugin could be handed", () => {
    expect(
      resolveFilePreviewRendererGated({
        filePath: "/home/someone/notes.md",
        plugins,
        previewable: true,
        pluginEligible: false,
      }),
    ).toEqual({ kind: "markdown" });
  });

  it("does not give a plugin a file it has no path for", () => {
    expect(
      resolveFilePreviewRendererGated({
        filePath: "/home/someone/data.csv",
        plugins,
        previewable: true,
        pluginEligible: false,
      }),
    ).toEqual({ kind: "code" });
  });

  it("lets a plugin win inside the workspace", () => {
    expect(
      resolveFilePreviewRendererGated({
        filePath: "/repo/data.csv",
        plugins,
        previewable: true,
        pluginEligible: true,
      }),
    ).toMatchObject({ kind: "plugin", pluginId: "csv" });
  });

  it("falls back to code when nothing is previewable", () => {
    for (const filePath of ["/repo/notes.md", "/repo/data.csv"]) {
      expect(
        resolveFilePreviewRendererGated({
          filePath,
          plugins,
          previewable: false,
          pluginEligible: true,
        }),
        filePath,
      ).toEqual({ kind: "code" });
    }
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

  // The pane matches on suffix, so `.csv` also claims every `report.data.csv`.
  // Keyed on the literal strings, the report would call these two unrelated and
  // leave the narrower plugin silently overridden with nothing to show for it.
  it("reports a plugin whose extension is a suffix of another's", () => {
    const plugins = [
      installedPlugin({ id: "zeta-view", extensions: [".data.csv"] }),
      installedPlugin({ id: "alpha-view", extensions: [".csv"] }),
    ];

    expect(pluginFilePreviewConflicts(plugins)).toEqual([
      { extension: ".data.csv", winnerPluginId: "alpha-view", losingPluginIds: ["zeta-view"] },
    ]);
  });

  it("does not report a plugin whose two extensions are suffixes of each other", () => {
    const plugins = [installedPlugin({ id: "csv-table", extensions: [".csv", ".data.csv"] })];

    expect(pluginFilePreviewConflicts(plugins)).toEqual([]);
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
