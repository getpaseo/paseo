import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { bench, describe } from "vitest";
import {
  changelogCorpusFile,
  generatedCodeCorpusFile,
  jsonCorpusFile,
  pullRequestCorpus,
  realCodeCorpusFile,
  type BenchmarkCorpusFile,
} from "./benchmark-corpus";
import { buildDiffDocumentModel } from "./model";
import {
  createAdditiveAdvances,
  createChunkedAdvanceMeasurer,
  createChunkedWidthMeasurer,
  createMeasuredAdvances,
  requiresShaping,
} from "./text-measurement";
import type { BuildDiffDocumentModelInput, TextMeasurer } from "./types";

// The pure layout work the diff surface does when a diff opens or line wrap is
// toggled, without a browser or Skia. Counts are the backend-independent cost
// owners (how many strings a shaper has to see), timings are the JS overhead
// around them:
//   npx vitest bench --project unit src/git/diff-document/model.bench.ts

const DESKTOP_VIEWPORT = { width: 1400, height: 900 };
const PHONE_VIEWPORT = { width: 390, height: 800 };
const CELL_WIDTH = 7.8;

interface MeasurementStats {
  /** Whole strings handed to the backend. */
  calls: number;
  /** Characters inside those strings; canvas and Skia cost scales with this. */
  characters: number;
}

interface Backend {
  measurer: TextMeasurer;
  stats: MeasurementStats;
}

function monospaceWidth(text: string): number {
  let width = 0;
  for (const character of text) width += character.charCodeAt(0) > 0x2e7f ? 2 : 1;
  return width * CELL_WIDTH;
}

function countingMeasure(stats: MeasurementStats): (text: string) => number {
  return (text) => {
    stats.calls += 1;
    stats.characters += text.length;
    return monospaceWidth(text);
  };
}

/** Previous web backend, retained to isolate the cost of width-only probes. */
function webBackendWithoutWidthProbe(): Backend {
  const stats: MeasurementStats = { calls: 0, characters: 0 };
  const measure = countingMeasure(stats);
  return { stats, measurer: { measure, measureAdvances: createMeasuredAdvances(measure) } };
}

/**
 * `createWebTextMeasurer` in surface.web.tsx, with canvas replaced by a counter.
 * Width-only probes shape one string per chunk, like the native measurer; the
 * widths are the same sums, in the same order, as the last cumulative advance.
 */
function webBackend(): Backend {
  const stats: MeasurementStats = { calls: 0, characters: 0 };
  const measure = countingMeasure(stats);
  const additive = createAdditiveAdvances(measure);
  return {
    stats,
    measurer: {
      measure,
      measureAdvances: createMeasuredAdvances(measure),
      measureWidth: createChunkedWidthMeasurer((graphemes) => {
        const text = graphemes.join("");
        return requiresShaping(text) ? measure(text) : (additive(graphemes).at(-1) ?? 0);
      }),
    },
  };
}

/** `createNativeTextMeasurer` in text.native.ts, with Skia replaced by a counter. */
function nativeBackend(): Backend {
  const stats: MeasurementStats = { calls: 0, characters: 0 };
  const widths = new Map<string, number>();
  const additive = (graphemes: readonly string[]) => {
    let advance = 0;
    return graphemes.map((grapheme) => {
      let width = widths.get(grapheme);
      if (width === undefined) {
        stats.calls += 1;
        stats.characters += grapheme.length;
        width = monospaceWidth(grapheme);
        widths.set(grapheme, width);
      }
      return (advance += width);
    });
  };
  const shape = countingMeasure(stats);
  return {
    stats,
    measurer: {
      measure(text) {
        return requiresShaping(text) ? shape(text) : (additive([...text]).at(-1) ?? 0);
      },
      measureWidth: createChunkedWidthMeasurer((graphemes) => {
        const text = graphemes.join("");
        return requiresShaping(text) ? shape(text) : (additive(graphemes).at(-1) ?? 0);
      }),
      measureAdvances: createChunkedAdvanceMeasurer({
        requiresShaping,
        measureAdditive: additive,
        measureShaped(graphemes) {
          shape(graphemes.join(""));
          let advance = 0;
          return graphemes.map((grapheme) => (advance += monospaceWidth(grapheme)));
        },
      }),
    },
  };
}

function addedFile(file: BenchmarkCorpusFile): ParsedDiffFile {
  return {
    path: file.path,
    isNew: true,
    isDeleted: false,
    additions: file.lines.length,
    deletions: 0,
    hunks: [
      {
        oldStart: 0,
        oldCount: 0,
        newStart: 1,
        newCount: file.lines.length,
        lines: file.lines.map((content) => ({
          type: "add" as const,
          content,
          tokens: [{ text: content, style: null }],
        })),
      },
    ],
  };
}

interface Scenario {
  name: string;
  files: ParsedDiffFile[];
}

const SCENARIOS: Scenario[] = [
  { name: "real code (diff-pane.tsx)", files: [addedFile(realCodeCorpusFile())] },
  { name: "changelog (42 long prose lines)", files: [addedFile(changelogCorpusFile())] },
  { name: "generated code (1200 lines)", files: [addedFile(generatedCodeCorpusFile(1200))] },
  { name: "json (300 lines x 300 chars)", files: [addedFile(jsonCorpusFile(300))] },
  { name: "pull request (all of the above)", files: pullRequestCorpus().map(addedFile) },
];

function input(
  scenario: Scenario,
  options: {
    wrapLines: boolean;
    viewport: { width: number; height: number };
    measureText: TextMeasurer;
  },
): BuildDiffDocumentModelInput {
  return {
    files: scenario.files,
    collapsedFilePaths: new Set(),
    layout: "unified",
    wrapLines: options.wrapLines,
    viewportWidth: options.viewport.width,
    typography: { family: "monospace", size: 13, lineHeight: 20 },
    measureText: options.measureText,
    palette: {
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
      syntax: {},
    },
    labels: { binary: "Binary", tooLarge: "Too large" },
    // What the surfaces pass at scrollTop 0: five viewports tall.
    materializationWindow: { top: 0, height: options.viewport.height * 5 },
  };
}

interface Variant {
  name: string;
  wrapLines: boolean;
  viewport: { width: number; height: number };
  backend: () => Backend;
}

const VARIANTS: Variant[] = [
  {
    name: "unwrapped desktop | web",
    wrapLines: false,
    viewport: DESKTOP_VIEWPORT,
    backend: webBackend,
  },
  {
    name: "wrapped desktop | web",
    wrapLines: true,
    viewport: DESKTOP_VIEWPORT,
    backend: webBackend,
  },
  {
    name: "wrapped desktop | web without width probe",
    wrapLines: true,
    viewport: DESKTOP_VIEWPORT,
    backend: webBackendWithoutWidthProbe,
  },
  {
    name: "wrapped phone | web",
    wrapLines: true,
    viewport: PHONE_VIEWPORT,
    backend: webBackend,
  },
  {
    name: "unwrapped desktop | native",
    wrapLines: false,
    viewport: DESKTOP_VIEWPORT,
    backend: nativeBackend,
  },
  {
    name: "wrapped desktop | native",
    wrapLines: true,
    viewport: DESKTOP_VIEWPORT,
    backend: nativeBackend,
  },
  {
    name: "wrapped phone | native",
    wrapLines: true,
    viewport: PHONE_VIEWPORT,
    backend: nativeBackend,
  },
];

function countModel(scenario: Scenario, variant: Variant) {
  const { measurer, stats } = variant.backend();
  const started = performance.now();
  const model = buildDiffDocumentModel(
    input(scenario, {
      wrapLines: variant.wrapLines,
      viewport: variant.viewport,
      measureText: measurer,
    }),
  );
  const elapsedMs = performance.now() - started;
  let materializedCells = 0;
  let fragments = 0;
  let graphemes = 0;
  for (const row of model.rows) {
    if (row.kind !== "line") continue;
    for (const cell of row.cells) {
      if (!cell || cell.fragments.length === 0) continue;
      materializedCells += 1;
      fragments += cell.fragments.length;
      for (const fragment of cell.fragments) graphemes += fragment.graphemes.length;
    }
  }
  const sourceLines = scenario.files.reduce(
    (count, file) => count + file.hunks.reduce((total, hunk) => total + hunk.lines.length, 0),
    0,
  );
  return {
    sourceLines,
    materializedCells,
    fragments,
    graphemeObjects: graphemes,
    measureCalls: stats.calls,
    measuredCharacters: stats.characters,
    coldMs: Number(elapsedMs.toFixed(1)),
  };
}

const report: Record<string, ReturnType<typeof countModel>> = {};
for (const scenario of SCENARIOS) {
  for (const variant of VARIANTS) {
    report[`${scenario.name} | ${variant.name}`] = countModel(scenario, variant);
  }
}
console.table(report);

for (const scenario of SCENARIOS) {
  describe(scenario.name, () => {
    for (const variant of VARIANTS) {
      if (variant.backend === nativeBackend) continue;
      bench(variant.name, () => {
        buildDiffDocumentModel(
          input(scenario, {
            wrapLines: variant.wrapLines,
            viewport: variant.viewport,
            measureText: variant.backend().measurer,
          }),
        );
      });
    }
  });
}
