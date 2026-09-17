import { describe, expect, it } from "vitest";
import { selectChapterFiles, validateChapterOutline } from "./chapters.js";
import type { ChapterOutline, ParsedDiffFile } from "./messages.js";
const files: ParsedDiffFile[] = [
  {
    path: "feature.ts",
    isNew: true,
    isDeleted: false,
    additions: 4,
    deletions: 0,
    hunks: [
      {
        oldStart: 0,
        oldCount: 0,
        newStart: 1,
        newCount: 4,
        lines: [
          { type: "header", content: "@@ -0,0 +1,4 @@" },
          ...["first", "second", "third", "fourth"].map((content) => ({
            type: "add" as const,
            content,
          })),
        ],
      },
    ],
  },
];
function outline(): ChapterOutline {
  return {
    chapters: [
      {
        id: "first",
        title: "First behavior",
        description: "Introduce the behavior.",
        sections: [{ fileIndex: 0, hunkIndex: 0, startLine: 1, endLine: 3 }],
      },
      {
        id: "next",
        title: "Next behavior",
        description: "Build on it.",
        sections: [{ fileIndex: 0, hunkIndex: 0, startLine: 3, endLine: 5 }],
      },
    ],
    categories: [],
  };
}
describe("chapter coverage", () => {
  it("splits a new file while preserving original line coordinates", () => {
    const story = outline();
    validateChapterOutline(story, files);
    const [selected] = selectChapterFiles(files, story.chapters[1].sections);
    expect(selected.additions).toBe(2);
    expect(selected.hunks[0]).toMatchObject({ newStart: 3, newCount: 2, oldStart: 0, oldCount: 0 });
    expect(selected.hunks[0].lines[1]).toMatchObject({
      content: "third",
      sourceHunkIndex: 0,
      sourceLineIndex: 3,
    });
    expect(files[0].hunks[0].lines).toHaveLength(5);
  });
  it("rejects missing changes", () => {
    const story = outline();
    story.chapters.pop();
    expect(() => validateChapterOutline(story, files)).toThrow("2 changes have no chapter");
  });
  it("rejects overlapping and invented ranges", () => {
    const story = outline();
    story.chapters[1].sections[0].startLine = 2;
    expect(() => validateChapterOutline(story, files)).toThrow("Repeated change");
    story.chapters[1].sections[0].endLine = 6;
    expect(() => validateChapterOutline(story, files)).toThrow("Invalid range");
  });
  it("accounts for binary and metadata-only files", () => {
    const binary: ParsedDiffFile = {
      path: "image.png",
      isNew: true,
      isDeleted: false,
      additions: 0,
      deletions: 0,
      hunks: [],
      status: "binary",
    };
    const story = outline();
    story.chapters = [story.chapters[0]];
    story.chapters[0].sections = [{ fileIndex: 0, hunkIndex: null, startLine: 0, endLine: 0 }];
    validateChapterOutline(story, [binary]);
    expect(selectChapterFiles([binary], story.chapters[0].sections)).toEqual([binary]);
  });
});

it("requires ordered categories only above seven chapters", () => {
  const metadata = Array.from(
    { length: 8 },
    (_, index): ParsedDiffFile => ({
      path: `file-${index}`,
      isNew: false,
      isDeleted: false,
      additions: 0,
      deletions: 0,
      hunks: [],
    }),
  );
  const story: ChapterOutline = {
    chapters: metadata.map((_, index) => ({
      id: String(index),
      title: "Change",
      description: "Explain the change.",
      sections: [{ fileIndex: index, hunkIndex: null, startLine: 0, endLine: 0 }],
    })),
    categories: [],
  };
  expect(() => validateChapterOutline(story, metadata)).toThrow("require categories");
  story.categories = [
    {
      id: "first",
      title: "Core",
      description: "Introduce the core.",
      chapterIds: ["0", "1", "2", "3"],
    },
    {
      id: "second",
      title: "Supporting",
      description: "Complete the story.",
      chapterIds: ["4", "5", "6", "7"],
    },
  ];
  validateChapterOutline(story, metadata);
  story.categories[1].chapterIds.reverse();
  expect(() => validateChapterOutline(story, metadata)).toThrow("in story order");
});
