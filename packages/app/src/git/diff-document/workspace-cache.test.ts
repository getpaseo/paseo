import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { createDiffDocumentWorkspaceCache } from "./workspace-cache";
import type { BuildDiffDocumentModelInput, DiffPalette, TextMeasurer } from "./types";

const palette: DiffPalette = {
  surface: "#000",
  headerSurface: "#111",
  border: "#222",
  foreground: "#fff",
  foregroundMuted: "#aaa",
  addition: "green",
  deletion: "red",
  additionBackground: "#010",
  deletionBackground: "#100",
  emptyBackground: "#111",
  selection: "blue",
  syntax: { keyword: "purple" },
};

function diffFile(): ParsedDiffFile {
  return {
    path: "src/a.ts",
    isNew: false,
    isDeleted: false,
    additions: 1,
    deletions: 0,
    hunks: [
      {
        oldStart: 1,
        oldCount: 0,
        newStart: 1,
        newCount: 1,
        lines: [{ type: "add", content: "const answer = 42;" }],
      },
    ],
  };
}

function countingMeasurer() {
  const stats = { calls: 0 };
  const measureText: TextMeasurer = {
    measure(text) {
      stats.calls += 1;
      return text.length * 8;
    },
  };
  return { measureText, stats };
}

function modelInput(
  files: readonly ParsedDiffFile[],
  measureText: TextMeasurer,
  overrides: Partial<BuildDiffDocumentModelInput> = {},
): BuildDiffDocumentModelInput {
  return {
    files,
    collapsedFilePaths: new Set(),
    layout: "unified",
    wrapLines: false,
    viewportWidth: 800,
    typography: { family: "monospace", size: 12, lineHeight: 18 },
    measureText,
    palette,
    labels: { binary: "Binary", tooLarge: "Too large" },
    ...overrides,
  };
}

describe("diff document workspace cache", () => {
  it("reuses measured rows until a model-building input changes", () => {
    const cache = createDiffDocumentWorkspaceCache();
    const files = [diffFile()];
    const { measureText, stats } = countingMeasurer();
    const input = modelInput(files, measureText);

    const first = cache.buildModel(input);
    expect(stats.calls).toBeGreaterThan(0);

    stats.calls = 0;
    const second = cache.buildModel(input);
    expect(stats.calls).toBe(0);
    expect(second).toBe(first);

    const collapsed = cache.buildModel({
      ...input,
      collapsedFilePaths: new Set(["src/a.ts"]),
    });
    expect(collapsed).not.toBe(first);
    expect(collapsed.files[0]?.isCollapsed).toBe(true);

    cache.buildModel({ ...input, viewportWidth: 640 });
    expect(stats.calls).toBeGreaterThan(0);

    stats.calls = 0;
    cache.buildModel({
      ...input,
      typography: { family: "monospace", size: 13, lineHeight: 20 },
    });
    expect(stats.calls).toBeGreaterThan(0);

    stats.calls = 0;
    cache.buildModel({ ...input, palette: { ...palette, foreground: "#eee" } });
    expect(stats.calls).toBeGreaterThan(0);

    stats.calls = 0;
    cache.buildModel({ ...input, files: [...files] });
    expect(stats.calls).toBeGreaterThan(0);
  });

  it("bounds retained geometry variants for one diff payload", () => {
    const cache = createDiffDocumentWorkspaceCache();
    const files = [diffFile()];
    const { measureText, stats } = countingMeasurer();

    for (const viewportWidth of [600, 700, 800, 900, 1000]) {
      cache.buildModel(modelInput(files, measureText, { viewportWidth }));
    }

    stats.calls = 0;
    cache.buildModel(modelInput(files, measureText, { viewportWidth: 600 }));
    expect(stats.calls).toBeGreaterThan(0);
  });

  it("invalidates status rows when their translated labels change", () => {
    const cache = createDiffDocumentWorkspaceCache();
    const { measureText } = countingMeasurer();
    const files: ParsedDiffFile[] = [{ ...diffFile(), status: "binary", hunks: [] }];
    const first = cache.buildModel(modelInput(files, measureText));
    const second = cache.buildModel(
      modelInput(files, measureText, {
        labels: { binary: "Binary blob", tooLarge: "Too large" },
      }),
    );

    expect(first.rows[0]).toMatchObject({ kind: "status", label: "Binary" });
    expect(second.rows[0]).toMatchObject({ kind: "status", label: "Binary blob" });
  });

  it("shares loaded typography and its text measurer across mounts", async () => {
    const cache = createDiffDocumentWorkspaceCache();
    const { measureText } = countingMeasurer();
    let loadCount = 0;
    let measurerCount = 0;
    const typography = { family: "monospace", size: 12, lineHeight: 18 };
    const resource = cache.typography({
      typography,
      load: async () => {
        loadCount += 1;
      },
      createMeasurer: () => {
        measurerCount += 1;
        return measureText;
      },
    });
    const reused = cache.typography({
      typography: { ...typography },
      load: async () => {
        loadCount += 1;
      },
      createMeasurer: () => {
        measurerCount += 1;
        return measureText;
      },
    });

    expect(reused).toBe(resource);
    expect(measurerCount).toBe(1);
    await Promise.all([resource.load(), reused.load()]);
    expect(loadCount).toBe(1);
    expect(resource.isReady()).toBe(true);
  });
});
