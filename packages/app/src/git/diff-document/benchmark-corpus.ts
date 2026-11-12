import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The diff shapes the layout benchmarks measure, shared by the node bench
 * (`model.bench.ts`) and the browser benchmark (`e2e/browser/diff-performance.spec.ts`)
 * so both report against the same text.
 */
export interface BenchmarkCorpusFile {
  path: string;
  lines: string[];
}

function repeatToLength(unit: string, length: number): string {
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

/** A real source file: short lines, a few with ligature punctuation. */
export function realCodeCorpusFile(): BenchmarkCorpusFile {
  const source = readFileSync(path.resolve(__dirname, "../diff-pane.tsx"), "utf8");
  return { path: "packages/app/src/git/diff-pane.tsx", lines: source.split("\n") };
}

/** The CHANGELOG shape that once froze the renderer: 42 lines, longest ~600 characters. */
export function changelogCorpusFile(): BenchmarkCorpusFile {
  const sentence =
    "- Fixed an issue where the diff viewer re-measured every line -> on toggle, which made wrapping painfully slow. ";
  return {
    path: "CHANGELOG.md",
    lines: Array.from({ length: 42 }, (_, index) =>
      repeatToLength(sentence, 200 + ((index * 97) % 398)),
    ),
  };
}

/** Generated TypeScript: ligature punctuation on every line, every tenth line long. */
export function generatedCodeCorpusFile(lineCount: number): BenchmarkCorpusFile {
  return {
    path: "src/generated.ts",
    lines: Array.from({ length: lineCount }, (_, index) => {
      const base = `const handler${index} = async (event) => items.filter((item) => item.id !== ${index} && item.kind === "selected");`;
      return index % 10 === 9 ? repeatToLength(`${base} // `, 320) : base;
    }),
  };
}

/** Serialized data: no ligatures, every line wraps several times. */
export function jsonCorpusFile(lineCount: number): BenchmarkCorpusFile {
  return {
    path: "fixtures/data.json",
    lines: Array.from({ length: lineCount }, (_, index) =>
      repeatToLength(`{"id": ${index}, "label": "row ${index}", "tags": ["alpha", "beta"]}, `, 300),
    ),
  };
}

/** A pull-request-sized working diff: one of each shape above. */
export function pullRequestCorpus(): BenchmarkCorpusFile[] {
  return [
    realCodeCorpusFile(),
    changelogCorpusFile(),
    generatedCodeCorpusFile(1200),
    jsonCorpusFile(300),
  ];
}
