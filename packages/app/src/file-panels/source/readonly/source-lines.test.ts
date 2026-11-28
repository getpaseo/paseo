import { highlightCode, type HighlightToken } from "@getpaseo/highlight";
import { describe, expect, it } from "vitest";
import { buildSourceLines } from "./source-lines";

const records = Array.from({ length: 900 }, (_, i) => ({
  t: `comment number ${i} with some text`,
  l: i % 7,
  r: i % 3,
  u: `user${i}`,
}));

const large = Array.from({ length: 14000 }, (_, i) => `export const item${i} = ${i};`).join("\n");

/** Collects every report until `count` have arrived. */
function build(
  input: {
    presentation: "highlighted" | "plain";
    content?: string;
    filename?: string;
    firstLines?: number;
  },
  count = 1,
) {
  return new Promise<HighlightToken[][][]>((resolve) => {
    const reports: HighlightToken[][][] = [];
    buildSourceLines(
      {
        content: input.content ?? large,
        filename: input.filename ?? "large.ts",
        presentation: input.presentation,
        firstLines: input.firstLines ?? 0,
      },
      (lines) => {
        reports.push(lines);
        if (reports.length === count) resolve(reports);
      },
    );
  });
}

describe("buildSourceLines", () => {
  it("reports the first lines, then the whole file, leaving the thread free between slices", async () => {
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 0);
    const [first, whole] = await build({ presentation: "highlighted", firstLines: 300 }, 2);
    clearInterval(ticker);

    const highlighted = highlightCode(large, "large.ts");
    expect(first.slice(0, 300)).toEqual(highlighted.slice(0, 300));
    expect(first[300]).toEqual([{ text: "export const item300 = 300;", style: null }]);
    expect(whole).toEqual(highlighted);
    expect(ticks).toBeGreaterThan(1);
  });

  it("splits plain lines without highlighting them", async () => {
    expect(await build({ presentation: "plain", content: "const a = 1;\n\nb" })).toEqual([
      [
        [{ text: "const a = 1;", style: null }],
        [{ text: "", style: null }],
        [{ text: "b", style: null }],
      ],
    ]);
  });

  it("reports the supplied single-line JSON as one complete plain token", async () => {
    const content = JSON.stringify(records);
    const filename = "one-line-repro.json";
    const [[line]] = await build({ content, filename, presentation: "highlighted" });

    expect(new TextEncoder().encode(content)).toHaveLength(60981);
    expect(line).toHaveLength(1);
    expect(line[0]).toEqual({ text: content, style: null });
  });

  it("keeps the pretty-printed control highlighted", async () => {
    const content = JSON.stringify(records, null, 2);
    const filename = "pretty-repro.json";
    const [lines] = await build({ content, filename, presentation: "highlighted" });

    expect(lines).toHaveLength(5402);
    expect(lines).toEqual(highlightCode(content, filename));
    expect(lines.flat().some((token) => token.style !== null)).toBe(true);
  });

  it("falls back for a dense row in the preview and full result", async () => {
    const filename = "data.json";
    const dense = `${JSON.stringify(Array.from({ length: 25 }, (_, i) => i))} `;
    const content = `${dense}\n{"ok":true}\n{"ok":false}\n`;
    const original = highlightCode(content, filename);
    expect(original[0]).toHaveLength(52);
    const [preview, full] = await build(
      { content, filename, presentation: "highlighted", firstLines: 1 },
      2,
    );

    expect(preview[0]).toEqual([{ text: dense, style: null }]);
    expect(full).toEqual([[{ text: dense, style: null }], ...original.slice(1)]);
  });

  it.each([
    ["data.json", JSON.stringify(Array.from({ length: 25 }, (_, i) => i)), 51],
    [
      "ordinary.ts",
      'const values = [{ id: 0, name: "item0" }, { id: 1, name: "item1" }, { id: 2, name: "item2" }];',
      50,
    ],
  ])("keeps %s highlighted within the span budget", async (filename, content, tokenCount) => {
    const original = highlightCode(content, filename);
    const [lines] = await build({ content, filename, presentation: "highlighted" });

    expect(original[0]).toHaveLength(tokenCount);
    expect(lines[0]).toHaveLength(tokenCount);
    expect(lines).toEqual(original);
  });

  it("preserves every line for unknown languages", async () => {
    const content = "hello\r\n\nworld\n";
    const [lines] = await build({ content, filename: "data.unknown", presentation: "highlighted" });
    expect(lines).toEqual(content.split("\n").map((text) => [{ text, style: null }]));
  });

  it("never reports lines once cancelled", async () => {
    let reported = false;
    const cancel = buildSourceLines(
      { content: large, filename: "large.ts", presentation: "highlighted", firstLines: 0 },
      () => {
        reported = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    cancel();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(reported).toBe(false);
  });
});
