import { createHash } from "node:crypto";
import {
  CHANGE_CATEGORIES,
  PRODUCTION_CATEGORIES,
  emptyChangeBreakdown,
  type ChangeBreakdown,
  type ChangeCategory,
} from "@getpaseo/protocol/diff-stat";
import type { ParsedDiffFile } from "../../server/utils/diff-highlighter.js";
import { classifyPath } from "./path.js";
import { analyzeSource, type SourceLine } from "./source.js";
interface ChangedLine {
  side: "additions" | "deletions";
  line: SourceLine;
  category: ChangeCategory;
}
function tokenKey(line: SourceLine): string {
  return JSON.stringify(line.tokens);
}

function classifyBlock(block: ChangedLine[]): void {
  const old = block.filter((line) => line.side === "deletions" && line.line.tokens.length);
  const added = block.filter((line) => line.side === "additions" && line.line.tokens.length);
  // Match in order. Matching equal tokens across positions can hide reordered
  // calls or statements as formatting-only changes.
  for (let index = 0; index < Math.min(old.length, added.length); index++) {
    const removed = old[index];
    const inserted = added[index];
    if (tokenKey(removed.line) !== tokenKey(inserted.line)) continue;
    const category =
      removed.line.comments.trim() === inserted.line.comments.trim() ? "formatting" : "comments";
    removed.category = category;
    inserted.category = category;
  }
  const remainingOld = old.filter((line) => isProduction(line.category));
  const remainingAdded = added.filter((line) => isProduction(line.category));
  const oldTokens = JSON.stringify(remainingOld.flatMap((line) => line.line.tokens));
  const newTokens = JSON.stringify(remainingAdded.flatMap((line) => line.line.tokens));
  if (remainingOld.length && remainingAdded.length && oldTokens === newTokens) {
    const oldComments = block
      .filter((line) => line.side === "deletions")
      .map((line) => line.line.comments.trim())
      .join("");
    const newComments = block
      .filter((line) => line.side === "additions")
      .map((line) => line.line.comments.trim())
      .join("");
    for (const line of [...remainingOld, ...remainingAdded])
      line.category = oldComments === newComments ? "formatting" : "comments";
    return;
  }
}

interface ClassifyDiffInput {
  file: ParsedDiffFile;
  oldContent: string | null;
  newContent: string | null;
}
const diffCache = new Map<string, ChangeBreakdown>();

export function classifyDiff(input: ClassifyDiffInput): ChangeBreakdown {
  const { file, oldContent, newContent } = input;
  const spans = file.hunks.map((hunk) => [
    hunk.oldStart,
    hunk.newStart,
    hunk.lines.map((line) => [line.type, line.content]),
  ]);
  const metadata = JSON.stringify([
    file.path,
    file.oldPath,
    file.additions,
    file.deletions,
    oldContent?.length,
    newContent?.length,
    spans,
  ]);
  const key = createHash("sha256")
    .update(metadata)
    .update(oldContent ?? "")
    .update(newContent ?? "")
    .digest("hex");
  const cached = diffCache.get(key);
  if (cached) return cached;
  const result = classifyUncached(input);
  diffCache.set(key, result);
  if (diffCache.size > 256) diffCache.delete(diffCache.keys().next().value!);
  return result;
}

function classifyUncached(input: ClassifyDiffInput): ChangeBreakdown {
  const { file, oldContent, newContent } = input;
  const result = emptyChangeBreakdown();
  const oldPath = file.oldPath ?? file.path;
  const oldCategory = classifyPath(oldPath, oldContent ?? "");
  const newCategory = classifyPath(file.path, newContent ?? "");
  const old = oldContent === null ? null : analyzeSource(oldPath, oldContent);
  const next = newContent === null ? null : analyzeSource(file.path, newContent);
  const sides = {
    additions: { source: next, category: newCategory },
    deletions: { source: old, category: oldCategory },
  };
  for (const hunk of file.hunks) {
    let oldLine = hunk.oldStart - 1;
    let newLine = hunk.newStart - 1;
    let block: ChangedLine[] = [];
    function flush(): void {
      classifyBlock(block);
      for (const line of block) result[line.category][line.side]++;
      block = [];
    }
    for (const line of hunk.lines) {
      if (line.type === "header") continue;
      if (line.type === "context") {
        flush();
        oldLine++;
        newLine++;
        continue;
      }
      const side = line.type === "add" ? "additions" : "deletions";
      const index = line.type === "add" ? newLine++ : oldLine++;
      const { source, category } = sides[side];
      if (!isProduction(category)) {
        result[category][side]++;
        continue;
      }
      const sourceLine = source?.lines[index];
      if (
        !source?.valid ||
        !sourceLine ||
        sourceLine.text.replace(/\r$/, "") !== line.content.replace(/\r$/, "")
      ) {
        result[category][side]++;
        result.commentsIncluded[side]++;
        continue;
      }
      let lineCategory = category;
      if (!sourceLine.tokens.length)
        lineCategory = sourceLine.comments.trim() ? "comments" : "blank";
      block.push({ side, line: sourceLine, category: lineCategory });
    }
    flush();
  }
  reconcile(result, file, { additions: newCategory, deletions: oldCategory });
  return result;
}

function isProduction(category: ChangeCategory): boolean {
  return PRODUCTION_CATEGORIES.some((entry) => entry === category);
}
function reconcile(
  result: ChangeBreakdown,
  file: ParsedDiffFile,
  categories: Record<"additions" | "deletions", ChangeCategory>,
): void {
  // Metadata-only, binary, truncated and racing reads retain the original Git totals.
  for (const side of ["additions", "deletions"] as const) {
    const classified = CHANGE_CATEGORIES.reduce((sum, category) => sum + result[category][side], 0);
    if (classified > file[side]) {
      for (const category of CHANGE_CATEGORIES) result[category][side] = 0;
      result.commentsIncluded[side] = 0;
      result.other[side] = file[side];
      continue;
    }
    const remaining = file[side] - classified;
    result[categories[side]][side] += remaining;
    if (isProduction(categories[side])) result.commentsIncluded[side] += remaining;
  }
}
