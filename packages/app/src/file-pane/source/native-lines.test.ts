import { describe, expect, it } from "vitest";
import { highlightCode } from "@getpaseo/highlight";
import { buildNativeSourceLines } from "./native-lines";

const records = Array.from({ length: 900 }, (_, i) => ({
  t: `comment number ${i} with some text`,
  l: i % 7,
  r: i % 3,
  u: `user${i}`,
}));

describe("native source lines", () => {
  it("opens the reported single-line JSON without thousands of native text spans", () => {
    const content = JSON.stringify(records);
    expect(new TextEncoder().encode(content)).toHaveLength(60981);
    expect(highlightCode(content, "one-line-repro.json")[0]).toHaveLength(14401);
    const lines = buildNativeSourceLines({
      content,
      filename: "one-line-repro.json",
      presentation: "highlighted",
    });
    expect(lines).toEqual([{ number: 1, tokens: [{ text: content, style: null }] }]);
  });

  it("keeps the pretty-printed control highlighted and preserves its line numbers", () => {
    const content = JSON.stringify(records, null, 2);
    const lines = buildNativeSourceLines({
      content,
      filename: "pretty-repro.json",
      presentation: "highlighted",
    });
    expect(lines).toHaveLength(5402);
    expect(lines.map((line) => line.tokens)).toEqual(highlightCode(content, "pretty-repro.json"));
    expect(lines.at(-1)?.number).toBe(5402);
    expect(lines.flatMap((line) => line.tokens).some((token) => token.style !== null)).toBe(true);
    expect(lines.map(lineText).join("\n")).toBe(content);
  });
  it("falls back only for dense rows, without changing text or line numbering", () => {
    const dense = `${JSON.stringify(Array.from({ length: 25 }, (_, i) => i))} `;
    const content = `${dense}\n{"ok":true}\n`;
    const original = highlightCode(content, "data.json");
    expect(original[0]).toHaveLength(52);
    const lines = buildNativeSourceLines({
      content,
      filename: "data.json",
      presentation: "highlighted",
    });
    expect(lines).toEqual([
      { number: 1, tokens: [{ text: dense, style: null }] },
      { number: 2, tokens: original[1] },
      { number: 3, tokens: original[2] },
    ]);
  });

  it("keeps a row at the span budget highlighted", () => {
    const content = JSON.stringify(Array.from({ length: 25 }, (_, i) => i));
    const original = highlightCode(content, "data.json");
    expect(original[0]).toHaveLength(51);
    expect(
      buildNativeSourceLines({ content, filename: "data.json", presentation: "highlighted" }),
    ).toEqual([{ number: 1, tokens: original[0] }]);
  });

  it("keeps ordinary TypeScript statements within the span budget highlighted", () => {
    const content =
      'const values = [{ id: 0, name: "item0" }, { id: 1, name: "item1" }, { id: 2, name: "item2" }];';
    const original = highlightCode(content, "ordinary.ts");
    expect(original[0]).toHaveLength(50);
    expect(
      buildNativeSourceLines({ content, filename: "ordinary.ts", presentation: "highlighted" }),
    ).toEqual([{ number: 1, tokens: original[0] }]);
  });

  it("keeps the plain tier and unknown languages lossless", () => {
    for (const presentation of ["highlighted", "plain"] as const) {
      const content = "hello\r\n\nworld\n";
      expect(buildNativeSourceLines({ content, filename: "data.unknown", presentation })).toEqual(
        content
          .split("\n")
          .map((text, index) => ({ number: index + 1, tokens: [{ text, style: null }] })),
      );
    }
  });
});

function lineText(line: { tokens: { text: string }[] }): string {
  return line.tokens.map((token) => token.text).join("");
}
