import { diffArrays } from "diff";
import { z } from "zod";
import type { HighlightToken } from "@getpaseo/highlight";

export interface DiffSegment {
  text: string;
  changed: boolean;
}

export interface DiffLine {
  type: "add" | "remove" | "context" | "header";
  content: string;
  segments?: DiffSegment[];
  // Syntax-highlight tokens for the code on this line (prefix char excluded),
  // attached by highlightDiffLines when the file's language is supported.
  tokens?: HighlightToken[];
}

function splitIntoLines(text: string): string[] {
  if (!text) {
    return [];
  }

  return text.replace(/\r\n/g, "\n").split("\n");
}

const WORD_TOKEN_RE =
  /[A-Za-z0-9_$]+|[\u3000-\u9fff\u3040-\u30ff\uac00-\ud7af]|\s+|[^A-Za-z0-9_$\s\u3000-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;

function splitIntoWords(text: string): string[] {
  return text.match(WORD_TOKEN_RE) ?? [];
}

const MAX_EDIT_DISTANCE = 256;
const FULL_CONTEXT_LINE_LIMIT = 128;
const CONTEXT_LINES = 3;
const REPLACEMENT_PREVIEW_LINES = 32;
const MAX_WORD_DIFF_LINE_LENGTH = 2000;
const MAX_WORD_DIFF_EDIT_DISTANCE = 128;
const MAX_WORD_DIFF_CHANGE_RATIO = 0.75;
const OMITTED_LINES: DiffLine = { type: "header", content: "…" };

function stripDiffMarker(line: DiffLine): string {
  if (line.type === "remove" && line.content.startsWith("-")) {
    return line.content.slice(1);
  }
  if (line.type === "add" && line.content.startsWith("+")) {
    return line.content.slice(1);
  }
  return line.content;
}

function computeLinePairSegments(
  before: DiffLine,
  after: DiffLine,
): { beforeSegments: DiffSegment[]; afterSegments: DiffSegment[] } | null {
  const oldText = stripDiffMarker(before);
  const newText = stripDiffMarker(after);
  if (oldText === newText) return null;
  if (oldText.length > MAX_WORD_DIFF_LINE_LENGTH || newText.length > MAX_WORD_DIFF_LINE_LENGTH) {
    return null;
  }

  const words = diffArrays(splitIntoWords(oldText), splitIntoWords(newText), {
    maxEditLength: MAX_WORD_DIFF_EDIT_DISTANCE,
  });
  if (!words) return null;

  const beforeSegments: DiffSegment[] = [];
  const afterSegments: DiffSegment[] = [];
  let changedBefore = 0;
  let changedAfter = 0;

  for (const part of words) {
    const text = part.value.join("");
    if (!text) continue;
    if (!part.added) {
      const changed = Boolean(part.removed);
      if (changed) changedBefore += text.length;
      beforeSegments.push({ text, changed });
    }
    if (!part.removed) {
      const changed = Boolean(part.added);
      if (changed) changedAfter += text.length;
      afterSegments.push({ text, changed });
    }
  }

  if (changedBefore === 0 && changedAfter === 0) return null;
  if (
    oldText.length > 0 &&
    newText.length > 0 &&
    changedBefore > oldText.length * MAX_WORD_DIFF_CHANGE_RATIO &&
    changedAfter > newText.length * MAX_WORD_DIFF_CHANGE_RATIO
  ) {
    return null;
  }

  return { beforeSegments, afterSegments };
}

function addWordHighlights(diff: DiffLine[]): void {
  let index = 0;
  while (index < diff.length) {
    if (diff[index].type !== "remove") {
      index += 1;
      continue;
    }
    const removeStart = index;
    while (index < diff.length && diff[index].type === "remove") {
      index += 1;
    }
    const removeEnd = index;
    const addStart = index;
    while (index < diff.length && diff[index].type === "add") {
      index += 1;
    }
    const addEnd = index;
    const pairCount = Math.min(removeEnd - removeStart, addEnd - addStart);
    for (let offset = 0; offset < pairCount; offset += 1) {
      const before = diff[removeStart + offset];
      const after = diff[addStart + offset];
      const result = computeLinePairSegments(before, after);
      if (!result) continue;
      before.segments = result.beforeSegments;
      after.segments = result.afterSegments;
    }
  }
}

function contextPreview(
  lines: string[],
  hasEditBefore: boolean,
  hasEditAfter: boolean,
): DiffLine[] {
  const leadingCount = hasEditBefore ? CONTEXT_LINES : 0;
  const trailingCount = hasEditAfter ? CONTEXT_LINES : 0;
  if (lines.length <= leadingCount + trailingCount) return contextLines(lines);

  return [
    ...contextLines(lines.slice(0, leadingCount)),
    OMITTED_LINES,
    ...contextLines(lines.slice(lines.length - trailingCount)),
  ];
}

function contextLines(lines: string[]): DiffLine[] {
  return lines.map((line) => ({ type: "context", content: ` ${line}` }));
}

function splitLineChange(before: string[], after: string[]) {
  let start = 0;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (start < beforeEnd && start < afterEnd && before[start] === after[start]) start++;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd--;
    afterEnd--;
  }
  return {
    leading: before.slice(0, start),
    before: before.slice(start, beforeEnd),
    after: after.slice(start, afterEnd),
    trailing: before.slice(beforeEnd),
  };
}

function buildReplacementPreview(before: string[], after: string[]): DiffLine[] {
  return [
    ...before
      .slice(0, REPLACEMENT_PREVIEW_LINES)
      .map((line): DiffLine => ({ type: "remove", content: `-${line}` })),
    ...after
      .slice(0, REPLACEMENT_PREVIEW_LINES)
      .map((line): DiffLine => ({ type: "add", content: `+${line}` })),
    OMITTED_LINES,
  ];
}

export function buildLineDiff(originalText: string, updatedText: string): DiffLine[] {
  const originalLines = splitIntoLines(originalText);
  const updatedLines = splitIntoLines(updatedText);
  // Anchor equal file edges so an edit to a repeated line stays at its original location.
  const { leading, before, after, trailing } = splitLineChange(originalLines, updatedLines);
  const compact = Math.max(originalLines.length, updatedLines.length) > FULL_CONTEXT_LINE_LIMIT;
  if (compact && before.length === 0 && after.length === 0) return [];

  const leadingRows = compact ? contextPreview(leading, false, true) : contextLines(leading);
  const changes = diffArrays(before, after, { maxEditLength: MAX_EDIT_DISTANCE });
  if (!changes) return [...leadingRows, ...buildReplacementPreview(before, after)];

  const changedRows = changes.flatMap((part): DiffLine[] => {
    if (part.removed) return part.value.map((line) => ({ type: "remove", content: `-${line}` }));
    if (part.added) return part.value.map((line) => ({ type: "add", content: `+${line}` }));
    return compact ? contextPreview(part.value, true, true) : contextLines(part.value);
  });
  addWordHighlights(changedRows);
  const trailingRows = compact ? contextPreview(trailing, true, false) : contextLines(trailing);
  return [...leadingRows, ...changedRows, ...trailingRows];
}

export function parseUnifiedDiff(diffText?: string): DiffLine[] {
  if (!diffText) {
    return [];
  }

  const lines = splitIntoLines(diffText);
  const fileHeaders = lines.filter((line) => line.startsWith("diff --git "));
  const hasMultipleFiles = fileHeaders.length > 1;
  const diff: DiffLine[] = [];

  for (const line of lines) {
    if (!line.length) {
      diff.push({ type: "context", content: line });
      continue;
    }

    const isFileHeader = hasMultipleFiles && line.startsWith("diff --git ");
    if (line.startsWith("@@") || isFileHeader) {
      diff.push({ type: "header", content: line });
      continue;
    }

    if (line.startsWith("+")) {
      if (!line.startsWith("+++")) {
        diff.push({ type: "add", content: line });
      }
      continue;
    }

    if (line.startsWith("-")) {
      if (!line.startsWith("---")) {
        diff.push({ type: "remove", content: line });
      }
      continue;
    }

    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("---") ||
      line.startsWith("+++")
    ) {
      continue;
    }

    if (line.startsWith("\\ No newline")) {
      diff.push({ type: "header", content: line });
      continue;
    }

    diff.push({ type: "context", content: line });
  }

  addWordHighlights(diff);
  return diff;
}

// ---- Task Extraction (cross-provider) ----

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskEntry {
  text: string;
  status: TaskStatus;
  completed: boolean;
}

const TaskStatusSchema = z.enum(["pending", "in_progress", "completed"]);

const ClaudeTodoWriteSchema = z.object({
  todos: z.array(
    z.object({
      content: z.string(),
      status: TaskStatusSchema,
      activeForm: z.string().optional(),
    }),
  ),
});

const UpdatePlanSchema = z.object({
  plan: z.array(
    z.object({
      step: z.string(),
      status: TaskStatusSchema.catch("pending"),
    }),
  ),
});

function normalizeToolName(toolName: string): string {
  return toolName
    .trim()
    .replace(/[.\s-]+/g, "_")
    .toLowerCase();
}

export function extractTaskEntriesFromToolCall(
  toolName: string,
  input: unknown,
): TaskEntry[] | null {
  const normalized = normalizeToolName(toolName);

  // Claude's plan mode uses ExitPlanMode for the approval prompt; it is not a task list.
  if (normalized === "exitplanmode") {
    return null;
  }

  if (normalized === "todowrite" || normalized === "todo_write") {
    const parsed = ClaudeTodoWriteSchema.safeParse(input);
    if (!parsed.success) {
      return null;
    }
    return parsed.data.todos.map((todo) => {
      const status = todo.status;
      const text = todo.activeForm?.trim() || todo.content.trim();
      return {
        text: text.length ? text : todo.content,
        status,
        completed: status === "completed",
      };
    });
  }

  if (normalized === "update_plan") {
    const parsed = UpdatePlanSchema.safeParse(input);
    if (!parsed.success) {
      return null;
    }
    return parsed.data.plan
      .map((entry) => ({
        text: entry.step.trim(),
        status: entry.status,
        completed: entry.status === "completed",
      }))
      .filter((entry) => entry.text.length > 0);
  }

  return null;
}
