import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { createDiffDocumentWorkspaceCache } from "./workspace-cache";
import type {
  BuildDiffDocumentModelInput,
  DiffDocumentModel,
  DiffPalette,
  TextMeasurer,
} from "./types";

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
  headerActiveSurface: "#222",
  headerBorder: "#333",
  statusSuccess: "green",
  statusDanger: "red",
  statusWarning: "orange",
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
  it("keeps text prepared in each visited window of the same file", () => {
    const cache = createDiffDocumentWorkspaceCache();
    const source = diffFile();
    source.hunks[0]!.lines = Array.from({ length: 100 }, (_, index) => ({
      type: "add",
      content: `const value${index} = ${index};`,
    }));
    const { measureText, stats } = countingMeasurer();
    const input = modelInput([source], measureText);
    for (const top of [30, 300, 600]) {
      cache.buildModel({ ...input, materializationWindow: { top, height: 54 } });
    }
    stats.calls = 0;
    cache.buildModel({ ...input, materializationWindow: { top: 300, height: 54 } });
    expect(stats.calls).toBe(0);
  });

  it("retains text cells for unchanged files when another file changes", () => {
    const cache = createDiffDocumentWorkspaceCache();
    const { measureText } = countingMeasurer();
    const files = [diffFile(), { ...diffFile(), path: "b.ts" }];
    const first = cache.buildModel(modelInput(files, measureText));
    const replacement = structuredClone(files[0]!);
    replacement.hunks[0]!.lines[0]!.content = "changed text";
    const next = cache.buildModel(modelInput([replacement, files[1]!], measureText));
    const oldRow = first.rows[first.files[1]!.rowStart]!;
    const nextRow = next.rows[next.files[1]!.rowStart]!;
    expect(oldRow.kind).toBe("line");
    expect(nextRow.kind).toBe("line");
    if (oldRow.kind !== "line" || nextRow.kind !== "line") throw new Error("Missing file text");
    expect(nextRow.cells).toBe(oldRow.cells);
    expect(next.files[0]!.file).toBe(replacement);
  });

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
    expect(stats.calls).toBe(0);
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

  it("materializes successive unwrapped windows without remeasuring retained files", () => {
    const cache = createDiffDocumentWorkspaceCache();
    const files = [diffFile(), { ...diffFile(), path: "src/b.ts" }];
    const { measureText, stats } = countingMeasurer();
    const first = cache.buildModel(
      modelInput(files, measureText, { materializationWindow: { top: 30, height: 20 } }),
    );
    const firstCalls = stats.calls;
    const secondFile = first.files[1]!;

    const second = cache.buildModel(
      modelInput(files, measureText, {
        materializationWindow: {
          top: secondFile.top,
          height: secondFile.bottom - secondFile.top,
        },
      }),
    );

    expect(firstCalls).toBeGreaterThan(0);
    expect(stats.calls).toBeGreaterThan(firstCalls);
    expect(measuredFragmentCount(first, 0)).toBeGreaterThan(0);
    expect(measuredFragmentCount(first, 1)).toBe(0);
    expect(measuredFragmentCount(second, 0)).toBeGreaterThan(0);
    expect(measuredFragmentCount(second, 1)).toBeGreaterThan(0);
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

function measuredFragmentCount(model: DiffDocumentModel, fileIndex: number): number {
  const file = model.files[fileIndex];
  if (!file) throw new Error(`Expected file ${fileIndex}`);
  return model.rows
    .slice(file.rowStart, file.rowEnd)
    .filter((row) => row.kind === "line")
    .flatMap((row) => row.cells)
    .reduce((count, cell) => count + (cell?.fragments.length ?? 0), 0);
}
