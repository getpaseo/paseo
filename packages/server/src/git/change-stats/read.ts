import { readFile, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  emptyChangeBreakdown,
  sumDiffStats,
  type ChangeBreakdown,
  type DiffStat,
} from "@getpaseo/protocol/diff-stat";
import { parseDiff, type ParsedDiffFile } from "../../server/utils/diff-highlighter.js";
import { runGitCommand, type RunGitCommand } from "../../utils/run-git-command.js";
import { classifyDiff } from "./classify.js";
import { classifyPath } from "./path.js";

const MAX_BYTES = 1024 * 1024;
const immutableContentCache = new Map<string, string>();
let cachedContentCharacters = 0;
const MAX_ANALYZED_FILES = 500;
interface Comparison {
  cwd: string;
  baseRef: string;
  targetRef?: string;
  runGit?: RunGitCommand;
}

async function readContent(input: Comparison, path: string, ref?: string): Promise<string | null> {
  if (ref) {
    const key = `${input.cwd}:${ref}:${path}`;
    const cached = immutableContentCache.get(key);
    if (cached !== undefined) return cached;
    const result = await (input.runGit ?? runGitCommand)(["show", `${ref}:${path}`], {
      cwd: input.cwd,
      maxOutputBytes: MAX_BYTES,
      acceptExitCodes: [0, 128],
    });
    if (result.exitCode !== 0 || result.truncated) return null;
    if (/^[a-f0-9]{40,64}$/.test(ref)) {
      immutableContentCache.set(key, result.stdout);
      cachedContentCharacters += result.stdout.length;
      while (immutableContentCache.size > 256 || cachedContentCharacters > 8 * 1024 * 1024) {
        const oldest = immutableContentCache.keys().next().value!;
        cachedContentCharacters -= immutableContentCache.get(oldest)!.length;
        immutableContentCache.delete(oldest);
      }
    }
    return result.stdout;
  }
  try {
    const filePath = resolve(input.cwd, path);
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.size > MAX_BYTES) return null;
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "EACCES", "EPERM"].includes(String(error.code))
    )
      return null;
    throw error;
  }
}

export async function readFileBreakdown(
  input: Comparison & { file: ParsedDiffFile; loadPatch?: boolean },
): Promise<ChangeBreakdown> {
  const { file } = input;
  const oldPath = file.oldPath ?? file.path;
  const oldCategory = classifyPath(oldPath);
  const newCategory = classifyPath(file.path);
  const excluded = new Set(["docs", "generated", "other"]);
  if (
    file.status === "too_large" ||
    file.additions + file.deletions === 0 ||
    (excluded.has(oldCategory) && excluded.has(newCategory))
  ) {
    return classifyDiff({ file, oldContent: null, newContent: null });
  }
  const [oldContent, newContent] = await Promise.all([
    file.isNew ? Promise.resolve("") : readContent(input, oldPath, input.baseRef),
    file.isDeleted ? Promise.resolve("") : readContent(input, file.path, input.targetRef),
  ]);
  let hunks = file.hunks;
  if (input.loadPatch && file.hunks.length === 0 && (file.additions || file.deletions)) {
    const refs = input.targetRef ? [input.baseRef, input.targetRef] : [input.baseRef];
    const patch = await (input.runGit ?? runGitCommand)(
      [
        "--literal-pathspecs",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--unified=0",
        ...refs,
        "--",
        oldPath,
        file.path,
      ],
      { cwd: input.cwd, maxOutputBytes: MAX_BYTES },
    );
    if (!patch.truncated) hunks = parseDiff(patch.stdout)[0]?.hunks ?? [];
  }
  return classifyDiff({ file: { ...file, hunks }, oldContent, newContent });
}

export async function addFileBreakdowns(
  input: Comparison & { files: ParsedDiffFile[]; loadPatch?: boolean },
): Promise<void> {
  for (let offset = 0; offset < Math.min(input.files.length, MAX_ANALYZED_FILES); offset += 4) {
    await Promise.all(
      input.files.slice(offset, offset + 4).map(async (file) => {
        if (file.breakdown) return;
        file.breakdown = await readFileBreakdown({ ...input, file });
      }),
    );
  }
  for (const file of input.files.slice(MAX_ANALYZED_FILES)) {
    file.breakdown = classifyDiff({
      file: { ...file, hunks: [] },
      oldContent: null,
      newContent: null,
    });
  }
}

export function parseNumstat(text: string): ParsedDiffFile[] {
  const fields = text.split("\0");
  const files: ParsedDiffFile[] = [];
  for (let i = 0; i < fields.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[i]);
    if (!match) continue;
    let path = match[3];
    let oldPath: string | undefined;
    if (!path) {
      oldPath = fields[++i];
      path = fields[++i];
    }
    if (!path) continue;
    files.push({
      path,
      oldPath,
      additions: match[1] === "-" ? 0 : Number(match[1]),
      deletions: match[2] === "-" ? 0 : Number(match[2]),
      isNew: false,
      isDeleted: false,
      hunks: [],
    });
  }
  return files;
}

export async function readComparisonBreakdown(
  input: Comparison & { total: DiffStat },
): Promise<ChangeBreakdown> {
  const git = input.runGit ?? runGitCommand;
  const refs = input.targetRef ? [input.baseRef, input.targetRef] : [input.baseRef];
  const result = await git(["diff", "--numstat", "-z", ...refs], { cwd: input.cwd });
  if (result.truncated) {
    const breakdown = emptyChangeBreakdown();
    breakdown.other = { additions: input.total.additions, deletions: input.total.deletions };
    return breakdown;
  }
  const files = parseNumstat(result.stdout);
  const patch = await git(["diff", "--no-ext-diff", "--no-textconv", "--unified=0", ...refs], {
    cwd: input.cwd,
  });
  if (!patch.truncated) {
    const parsed = parseDiff(patch.stdout);
    // Both Git streams use the same path order. Matching counts additionally
    // prevents attributing a racing patch to the wrong metadata record.
    if (parsed.length === files.length) {
      for (let index = 0; index < files.length; index++) {
        if (
          files[index].additions === parsed[index].additions &&
          files[index].deletions === parsed[index].deletions
        )
          files[index].hunks = parsed[index].hunks;
      }
    }
  }
  await addFileBreakdowns({ ...input, files });
  if (!input.targetRef) {
    const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: input.cwd,
    });
    for (const path of untracked.stdout.split("\0").filter(Boolean).slice(0, 500)) {
      const content = await readContent(input, path);
      if (!content || content.includes("\0")) continue;
      const lines = content.replace(/\r\n/g, "\n").split("\n");
      if (lines.at(-1) === "") lines.pop();
      const file: ParsedDiffFile = {
        path,
        isNew: true,
        isDeleted: false,
        additions: lines.length,
        deletions: 0,
        hunks: [
          {
            oldStart: 0,
            oldCount: 0,
            newStart: 1,
            newCount: lines.length,
            lines: lines.map((line) => ({ type: "add", content: line })),
          },
        ],
      };
      file.breakdown = classifyDiff({ file, oldContent: "", newContent: content });
      files.push(file);
    }
  }
  const sum = sumDiffStats(files);
  const breakdown = sum.breakdown ?? emptyChangeBreakdown();
  // A working tree can change between Git's total and the content reads. Do not
  // display a partition from a different snapshot as if it reconciled.
  if (sum.additions > input.total.additions || sum.deletions > input.total.deletions) {
    const unknown = emptyChangeBreakdown();
    unknown.other = { additions: input.total.additions, deletions: input.total.deletions };
    return unknown;
  }
  breakdown.other.additions += input.total.additions - sum.additions;
  breakdown.other.deletions += input.total.deletions - sum.deletions;
  return breakdown;
}
