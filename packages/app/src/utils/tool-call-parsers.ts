import { z } from "zod";
import { getNowMs, isPerfLoggingEnabled, perfLog } from "./perf";

const TOOL_CALL_DIFF_LOG_TAG = "[ToolCallDiff]";
const LINE_DIFF_DURATION_THRESHOLD_MS = 16;
const WORD_DIFF_DURATION_THRESHOLD_MS = 8;
const LINE_DIFF_MATRIX_THRESHOLD = 200000;
const WORD_DIFF_MATRIX_THRESHOLD = 50000;

export type DiffSegment = {
  text: string;
  changed: boolean;
};

export type DiffLine = {
  type: "add" | "remove" | "context" | "header";
  content: string;
  segments?: DiffSegment[];
};

function splitIntoLines(text: string): string[] {
  if (!text) {
    return [];
  }

  return text.replace(/\r\n/g, "\n").split("\n");
}

function splitIntoWords(text: string): string[] {
  const result: string[] = [];
  let current = "";
  let inWord = false;

  for (const char of text) {
    const isWordChar = /\w/.test(char);
    if (isWordChar) {
      if (!inWord && current) {
        result.push(current);
        current = "";
      }
      inWord = true;
      current += char;
    } else {
      if (inWord && current) {
        result.push(current);
        current = "";
      }
      inWord = false;
      current += char;
    }
  }
  if (current) {
    result.push(current);
  }
  return result;
}

function computeWordLevelDiff(oldLine: string, newLine: string): { oldSegments: DiffSegment[]; newSegments: DiffSegment[] } {
  const shouldLog = isPerfLoggingEnabled();
  const startMs = shouldLog ? getNowMs() : 0;
  const oldWords = splitIntoWords(oldLine);
  const newWords = splitIntoWords(newLine);

  const m = oldWords.length;
  const n = newWords.length;
  const matrixSize = m * n;

  // LCS to find common words
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (oldWords[i] === newWords[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  // Mark which words are in LCS (unchanged)
  const oldInLCS = new Set<number>();
  const newInLCS = new Set<number>();

  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldWords[i] === newWords[j]) {
      oldInLCS.add(i);
      newInLCS.add(j);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  // Build segments: consecutive unchanged or changed words merged
  const buildSegments = (words: string[], inLCS: Set<number>): DiffSegment[] => {
    if (words.length === 0) return [];

    const segments: DiffSegment[] = [];
    let currentText = "";
    let currentChanged: boolean | null = null;

    for (let idx = 0; idx < words.length; idx++) {
      const word = words[idx];
      const changed = !inLCS.has(idx);

      if (currentChanged === null) {
        currentText = word;
        currentChanged = changed;
      } else if (changed === currentChanged) {
        currentText += word;
      } else {
        segments.push({ text: currentText, changed: currentChanged });
        currentText = word;
        currentChanged = changed;
      }
    }

    if (currentText) {
      segments.push({ text: currentText, changed: currentChanged ?? false });
    }

    return segments;
  };

  const oldSegments = buildSegments(oldWords, oldInLCS);
  const newSegments = buildSegments(newWords, newInLCS);

  if (shouldLog) {
    const durationMs = getNowMs() - startMs;
    if (
      durationMs >= WORD_DIFF_DURATION_THRESHOLD_MS ||
      matrixSize >= WORD_DIFF_MATRIX_THRESHOLD
    ) {
      perfLog(TOOL_CALL_DIFF_LOG_TAG, {
        event: "word_diff",
        durationMs: Math.round(durationMs),
        oldWordCount: m,
        newWordCount: n,
        matrixSize,
      });
    }
  }

  return {
    oldSegments,
    newSegments,
  };
}

export function buildLineDiff(originalText: string, updatedText: string): DiffLine[] {
  const shouldLog = isPerfLoggingEnabled();
  const startMs = shouldLog ? getNowMs() : 0;
  const originalLines = splitIntoLines(originalText);
  const updatedLines = splitIntoLines(updatedText);

  const hasAnyContent = originalLines.length > 0 || updatedLines.length > 0;
  if (!hasAnyContent) {
    return [];
  }

  const m = originalLines.length;
  const n = updatedLines.length;
  const matrixSize = m * n;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );

  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (originalLines[i] === updatedLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const diff: DiffLine[] = [];

  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (originalLines[i] === updatedLines[j]) {
      diff.push({ type: "context", content: ` ${originalLines[i]}` });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      diff.push({ type: "remove", content: `-${originalLines[i]}` });
      i += 1;
    } else {
      diff.push({ type: "add", content: `+${updatedLines[j]}` });
      j += 1;
    }
  }

  while (i < m) {
    diff.push({ type: "remove", content: `-${originalLines[i]}` });
    i += 1;
  }

  while (j < n) {
    diff.push({ type: "add", content: `+${updatedLines[j]}` });
    j += 1;
  }

  // Post-process to add word-level segments for adjacent remove/add pairs
  for (let idx = 0; idx < diff.length - 1; idx++) {
    const curr = diff[idx];
    const next = diff[idx + 1];

    if (curr.type === "remove" && next.type === "add") {
      // Strip the leading -/+ from content for comparison
      const oldLineText = curr.content.slice(1);
      const newLineText = next.content.slice(1);

      const { oldSegments, newSegments } = computeWordLevelDiff(oldLineText, newLineText);
      curr.segments = oldSegments;
      next.segments = newSegments;
    }
  }

  if (shouldLog) {
    const durationMs = getNowMs() - startMs;
    if (
      durationMs >= LINE_DIFF_DURATION_THRESHOLD_MS ||
      matrixSize >= LINE_DIFF_MATRIX_THRESHOLD
    ) {
      perfLog(TOOL_CALL_DIFF_LOG_TAG, {
        event: "line_diff",
        durationMs: Math.round(durationMs),
        originalLineCount: m,
        updatedLineCount: n,
        diffLineCount: diff.length,
        matrixSize,
      });
    }
  }

  return diff;
}

export function parseUnifiedDiff(diffText?: string): DiffLine[] {
  if (!diffText) {
    return [];
  }

  const lines = splitIntoLines(diffText);
  const diff: DiffLine[] = [];

  for (const line of lines) {
    if (!line.length) {
      diff.push({ type: "context", content: line });
      continue;
    }

    if (line.startsWith("@@")) {
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

  return diff;
}

// ---- Task Extraction (cross-provider) ----

export type TaskStatus = "pending" | "in_progress" | "completed";

export type TaskEntry = {
  text: string;
  status: TaskStatus;
  completed: boolean;
};

const TaskStatusSchema = z.enum(["pending", "in_progress", "completed"]);

const ClaudeTodoWriteSchema = z.object({
  todos: z.array(
    z.object({
      content: z.string(),
      status: TaskStatusSchema,
      activeForm: z.string().optional(),
    })
  ),
});

const UpdatePlanSchema = z.object({
  plan: z.array(
    z.object({
      step: z.string(),
      status: TaskStatusSchema.catch("pending"),
    })
  ),
});

function normalizeToolName(toolName: string): string {
  return toolName.trim().replace(/[.\s-]+/g, "_").toLowerCase();
}

export function extractTaskEntriesFromToolCall(
  toolName: string,
  input: unknown
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
