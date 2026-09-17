import type { ChapterOutline, ChapterSection, ParsedDiffFile } from "./messages.js";

export class ChapterValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChapterValidationError";
  }
}

function changed(type: string): boolean {
  return type === "add" || type === "remove";
}

/** Positions refer to the immutable source patch, never to a previously sliced view. */
export function validateChapterOutline(outline: ChapterOutline, files: ParsedDiffFile[]): void {
  const expected = new Set<string>();
  files.forEach((file, f) => {
    let count = 0;
    file.hunks.forEach((hunk, h) =>
      hunk.lines.forEach((line, l) => {
        if (changed(line.type)) {
          expected.add(`${f}:${h}:${l}`);
          count++;
        }
      }),
    );
    if (count === 0) expected.add(`${f}:metadata`);
  });
  const seen = new Set<string>();
  const chapterIds = new Set<string>();
  function claim(key: string) {
    if (!expected.has(key)) throw new ChapterValidationError(`Unknown change ${key}`);
    if (seen.has(key)) throw new ChapterValidationError(`Repeated change ${key}`);
    seen.add(key);
  }
  for (const chapter of outline.chapters) {
    if (chapterIds.has(chapter.id))
      throw new ChapterValidationError(`Repeated chapter ${chapter.id}`);
    chapterIds.add(chapter.id);
    for (const section of chapter.sections) {
      const file = files[section.fileIndex];
      if (!file) throw new ChapterValidationError(`Unknown file ${section.fileIndex}`);
      if (section.hunkIndex === null) {
        if (section.startLine !== 0 || section.endLine !== 0)
          throw new ChapterValidationError("Metadata sections use 0, 0");
        claim(`${section.fileIndex}:metadata`);
        continue;
      }
      const hunk = file.hunks[section.hunkIndex];
      if (!hunk || section.endLine <= section.startLine || section.endLine > hunk.lines.length) {
        throw new ChapterValidationError(`Invalid range in ${file.path}`);
      }
      let count = 0;
      for (let l = section.startLine; l < section.endLine; l++) {
        if (!changed(hunk.lines[l].type)) continue;
        claim(`${section.fileIndex}:${section.hunkIndex}:${l}`);
        count++;
      }
      if (!count) throw new ChapterValidationError(`Section in ${file.path} has no changes`);
    }
  }
  if (seen.size !== expected.size)
    throw new ChapterValidationError(`${expected.size - seen.size} changes have no chapter`);
  validateCategories(outline);
}

function validateCategories(outline: ChapterOutline): void {
  if (outline.chapters.length <= 7 && outline.categories.length)
    throw new ChapterValidationError("Use categories only above seven chapters");
  if (outline.chapters.length > 7 && outline.categories.length < 2)
    throw new ChapterValidationError("More than seven chapters require categories");
  const grouped = outline.categories.flatMap((category) => category.chapterIds);
  if (
    outline.categories.length &&
    (grouped.length !== outline.chapters.length ||
      grouped.some((id, index) => id !== outline.chapters[index]?.id))
  ) {
    throw new ChapterValidationError("Categories must partition chapters in story order");
  }
  const categoryIds = new Set(outline.categories.map((category) => category.id));
  if (categoryIds.size !== outline.categories.length)
    throw new ChapterValidationError("Repeated category id");
}

export function chapterChangedLines(sections: ChapterSection[], files: ParsedDiffFile[]): number {
  return sections.reduce((count, section) => {
    const file = files[section.fileIndex];
    if (section.hunkIndex === null) return count + file.additions + file.deletions;
    return (
      count +
      file.hunks[section.hunkIndex].lines
        .slice(section.startLine, section.endLine)
        .filter((line) => changed(line.type)).length
    );
  }, 0);
}

export function selectChapterFiles(
  files: ParsedDiffFile[],
  sections: ChapterSection[],
): ParsedDiffFile[] {
  const selected = new Map<number, ChapterSection[]>();
  for (const section of sections) {
    const entries = selected.get(section.fileIndex) ?? [];
    entries.push(section);
    selected.set(section.fileIndex, entries);
  }
  return [...selected].map(([fileIndex, ranges]) => {
    const file = files[fileIndex];
    if (ranges.some((range) => range.hunkIndex === null)) return file;
    const hunks = ranges.map((range) => sliceHunk(file, range));
    const lines = hunks.flatMap((hunk) => hunk.lines);
    return Object.assign({}, file, {
      hunks,
      additions: lines.filter((line) => line.type === "add").length,
      deletions: lines.filter((line) => line.type === "remove").length,
    });
  });
}

function sliceHunk(file: ParsedDiffFile, range: ChapterSection): ParsedDiffFile["hunks"][number] {
  if (range.hunkIndex === null) throw new ChapterValidationError("Expected a text section");
  const hunk = file.hunks[range.hunkIndex];
  let oldStart = hunk.oldStart;
  let newStart = hunk.newStart;
  for (const line of hunk.lines.slice(0, range.startLine)) {
    if (line.type === "context" || line.type === "remove") oldStart++;
    if (line.type === "context" || line.type === "add") newStart++;
  }
  const selected = hunk.lines
    .slice(range.startLine, range.endLine)
    .map((line, index) =>
      Object.assign({}, line, {
        sourceHunkIndex: range.hunkIndex ?? 0,
        sourceLineIndex: range.startLine + index,
      }),
    )
    .filter((line) => line.type !== "header");
  const oldCount = selected.filter((line) => line.type !== "add").length;
  const newCount = selected.filter((line) => line.type !== "remove").length;
  const header: ParsedDiffFile["hunks"][number]["lines"][number] = {
    type: "header",
    content: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    sourceHunkIndex: range.hunkIndex,
    sourceLineIndex: range.startLine,
  };
  return { oldStart, newStart, oldCount, newCount, lines: [header, ...selected] };
}
