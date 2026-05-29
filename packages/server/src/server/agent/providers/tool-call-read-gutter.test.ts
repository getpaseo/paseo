import { describe, expect, it } from "vitest";

import { toReadToolDetail } from "./tool-call-detail-primitives.js";
import { stripReadLineNumberGutter } from "./tool-call-mapper-utils.js";

describe("stripReadLineNumberGutter", () => {
  it("strips a cat -n gutter and reports the first line number", () => {
    const result = stripReadLineNumberGutter(
      ["1\timport a from 'a';", "2\t", "3\tconst x = 1;"].join("\n"),
    );
    expect(result).toEqual({
      content: ["import a from 'a';", "", "const x = 1;"].join("\n"),
      startLine: 1,
    });
  });

  it("handles right-aligned numbers and a non-1 start offset", () => {
    const result = stripReadLineNumberGutter(["  41\tconst y = 2;", "  42\treturn y;"].join("\n"));
    expect(result).toEqual({
      content: ["const y = 2;", "return y;"].join("\n"),
      startLine: 41,
    });
  });

  it("keeps a trailing non-gutter notice but still strips the body", () => {
    const result = stripReadLineNumberGutter(
      ["1\tline one", "2\tline two", "<system-reminder>truncated</system-reminder>"].join("\n"),
    );
    expect(result?.content).toBe(
      ["line one", "line two", "<system-reminder>truncated</system-reminder>"].join("\n"),
    );
    expect(result?.startLine).toBe(1);
  });

  it("does not strip raw source without a gutter", () => {
    expect(stripReadLineNumberGutter("import a from 'a';\nconst x = 1;")).toBeUndefined();
  });

  it("does not strip when numbering is not sequential", () => {
    expect(stripReadLineNumberGutter("1\tfoo\n5\tbar")).toBeUndefined();
  });

  it("does not strip when the first non-empty line lacks a gutter", () => {
    expect(stripReadLineNumberGutter("header line\n1\tfoo\n2\tbar")).toBeUndefined();
  });

  it("returns undefined for empty content", () => {
    expect(stripReadLineNumberGutter(undefined)).toBeUndefined();
    expect(stripReadLineNumberGutter("")).toBeUndefined();
  });
});

describe("toReadToolDetail gutter normalization", () => {
  it("strips the gutter from output content and derives offset", () => {
    const detail = toReadToolDetail(
      { filePath: "/repo/src/index.ts" },
      { content: "10\tconst a = 1;\n11\tconst b = 2;" },
    );
    expect(detail).toEqual({
      type: "read",
      filePath: "/repo/src/index.ts",
      content: "const a = 1;\nconst b = 2;",
      offset: 10,
    });
  });

  it("prefers an explicit input offset over the gutter start", () => {
    const detail = toReadToolDetail(
      { filePath: "/repo/src/index.ts", offset: 10, limit: 2 },
      { content: "10\tconst a = 1;\n11\tconst b = 2;" },
    );
    expect(detail).toMatchObject({ offset: 10, limit: 2, content: "const a = 1;\nconst b = 2;" });
  });

  it("leaves raw content untouched", () => {
    const detail = toReadToolDetail(
      { filePath: "/repo/src/index.ts" },
      { content: "const a = 1;\nconst b = 2;" },
    );
    expect(detail).toEqual({
      type: "read",
      filePath: "/repo/src/index.ts",
      content: "const a = 1;\nconst b = 2;",
    });
  });
});
