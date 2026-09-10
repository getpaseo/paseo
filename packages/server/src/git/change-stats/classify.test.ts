import { describe, expect, it } from "vitest";
import { CHANGE_CATEGORIES, productionStat } from "@getpaseo/protocol/diff-stat";
import { classifyDiff } from "./classify.js";
import { classifyPath } from "./path.js";
import type { ParsedDiffFile } from "../../server/utils/diff-highlighter.js";

function compare(path: string, before: string, after: string) {
  const oldLines = before ? before.split("\n") : [];
  const newLines = after ? after.split("\n") : [];
  const file: ParsedDiffFile = {
    path,
    isNew: !before,
    isDeleted: !after,
    additions: newLines.length,
    deletions: oldLines.length,
    hunks: [
      {
        oldStart: 1,
        oldCount: oldLines.length,
        newStart: 1,
        newCount: newLines.length,
        lines: [
          ...oldLines.map((content) => ({ type: "remove" as const, content })),
          ...newLines.map((content) => ({ type: "add" as const, content })),
        ],
      },
    ],
  };
  const result = classifyDiff({ file, oldContent: before, newContent: after });
  expect(CHANGE_CATEGORIES.reduce((sum, category) => sum + result[category].additions, 0)).toBe(
    file.additions,
  );
  expect(CHANGE_CATEGORIES.reduce((sum, category) => sum + result[category].deletions, 0)).toBe(
    file.deletions,
  );
  return result;
}

describe("change classification", () => {
  it("separates trailing comment edits from production", () => {
    const result = compare("src/a.ts", "const a = 1; // before", "const a = 1; // after");
    expect(result.comments).toEqual({ additions: 1, deletions: 1 });
    expect(productionStat(result)).toEqual({ additions: 0, deletions: 0 });
  });
  it("counts mixed code/comment changes as production", () => {
    expect(compare("src/a.ts", "const a = 1; // before", "const a = 2; // after").code).toEqual({
      additions: 1,
      deletions: 1,
    });
  });
  it("does not mistake strings, templates or regular expressions for comments", () => {
    const result = compare(
      "src/a.ts",
      "",
      'const a = "// string";\nconst b = /[/*]/;\nconst c = `/* ${a} */`;',
    );
    expect(result.code.additions).toBe(3);
  });
  it("uses full-file context for multiline comments", () => {
    const file: ParsedDiffFile = {
      path: "a.ts",
      isNew: false,
      isDeleted: false,
      additions: 1,
      deletions: 1,
      hunks: [
        {
          oldStart: 2,
          oldCount: 1,
          newStart: 2,
          newCount: 1,
          lines: [
            { type: "remove", content: "old" },
            { type: "add", content: "new" },
          ],
        },
      ],
    };
    const result = classifyDiff({
      file,
      oldContent: "/*\nold\n*/\nconst a=1;",
      newContent: "/*\nnew\n*/\nconst a=1;",
    });
    expect(result.comments).toEqual({ additions: 1, deletions: 1 });
  });
  it("recognizes JSX comments while retaining JSX text", () => {
    expect(
      compare("a.tsx", "", "const a = <div>\n{/* explanation */}\nHello world\n</div>;").comments
        .additions,
    ).toBe(1);
    expect(
      compare("a.jsx", "const a = <div>Hello</div>;", "const a = <div>Goodbye</div>;").components
        .additions,
    ).toBe(1);
  });
  it("separates formatting and blanks", () => {
    expect(compare("a.ts", "const a=1;", "const a = 1;").formatting).toEqual({
      additions: 1,
      deletions: 1,
    });
    expect(compare("a.ts", "", "\nconst a=1;").blank.additions).toBe(1);
  });
  it("does not treat string whitespace edits as formatting", () => {
    expect(
      compare("a.ts", 'const a="hello world";', 'const a="hello  world";').code.additions,
    ).toBe(1);
  });
  it("classifies CSS comments and formatting", () => {
    expect(
      compare("a.css", "a { color: red; } /* old */", "a { color: red; } /* new */").comments
        .additions,
    ).toBe(1);
    expect(compare("a.css", "a{color:red}", "a { color: red }").formatting.additions).toBe(1);
  });
  it("file purpose owns comments in tests, docs and generated files", () => {
    expect(compare("a.test.ts", "", "// test\nconst x=1;").tests.additions).toBe(2);
    expect(compare("docs/a.ts", "", "// doc").docs.additions).toBe(1);
    expect(compare("a.ts", "", "// @generated\nconst a=1;").generated.additions).toBe(2);
    expect(classifyPath(".github/workflows/test.yml")).toBe("ci");
    expect(classifyPath("vite.config.ts")).toBe("config");
    expect(classifyPath("scripts/build.ts")).toBe("tooling");
  });
  it("reports comment-inclusive estimates for unsupported and malformed sources", () => {
    const python = compare("a.py", "", "# hello\nprint(1)");
    expect(python.otherCode.additions).toBe(2);
    expect(python.commentsIncluded.additions).toBe(2);
    const invalid = compare("a.ts", "", "const a = ;");
    expect(invalid.commentsIncluded.additions).toBe(1);
  });
  it("uses the old path and purpose for deletions after a rename", () => {
    const file: ParsedDiffFile = {
      path: "a.ts",
      oldPath: "a.test.ts",
      isNew: false,
      isDeleted: false,
      additions: 1,
      deletions: 1,
      hunks: [
        {
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 1,
          lines: [
            { type: "remove", content: "const a=1;" },
            { type: "add", content: "const a=2;" },
          ],
        },
      ],
    };
    const result = classifyDiff({ file, oldContent: "const a=1;", newContent: "const a=2;" });
    expect(result.tests.deletions).toBe(1);
    expect(result.code.additions).toBe(1);
  });
});

it("keeps adjacent formatting and comment edits in separate categories", () => {
  const result = compare(
    "a.ts",
    "const a=1; // before\nconst b=2;",
    "const a=1; // after\nconst b = 2;",
  );
  expect(result.comments).toEqual({ additions: 1, deletions: 1 });
  expect(result.formatting).toEqual({ additions: 1, deletions: 1 });
});
it("counts JSDoc as comments", () => {
  expect(
    compare("a.ts", "", "/** Explanation. */\nexport function f() {}").comments.additions,
  ).toBe(1);
});
it("does not classify automatic-semicolon changes as formatting", () => {
  const result = compare("a.ts", "function f() { return\n1; }", "function f() { return 1; }");
  expect(result.formatting.additions).toBe(0);
});
it("preserves significant selector whitespace in CSS", () => {
  const result = compare("a.css", "a :hover { color: red; }", "a:hover { color: red; }");
  expect(result.styles.additions).toBe(1);
});

it("counts reordered statements as production changes", () => {
  const result = compare("a.ts", "first();\nsecond();", "second();\nfirst();");
  expect(result.code).toEqual({ additions: 2, deletions: 2 });
  expect(result.formatting).toEqual({ additions: 0, deletions: 0 });
});
