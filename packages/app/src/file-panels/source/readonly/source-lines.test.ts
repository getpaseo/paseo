import { highlightCode, type HighlightToken } from "@getpaseo/highlight";
import { describe, expect, it } from "vitest";
import { buildSourceLines } from "./source-lines";

const large = Array.from({ length: 14000 }, (_, i) => `export const item${i} = ${i};`).join("\n");

/** Collects every report until `count` have arrived. */
function build(
  input: { presentation: "highlighted" | "plain"; content?: string; firstLines?: number },
  count = 1,
) {
  return new Promise<HighlightToken[][][]>((resolve) => {
    const reports: HighlightToken[][][] = [];
    buildSourceLines(
      {
        content: input.content ?? large,
        filename: "large.ts",
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
