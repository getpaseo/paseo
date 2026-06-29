import { z } from "zod";
import { type TaskProgressPayload, type TaskStatus, TaskStatusSchema } from "./messages.js";

export interface TaskEntry {
  text: string;
  status: TaskStatus;
  completed: boolean;
}

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

/**
 * Normalize a tool name for task-list detection. Kept distinct from
 * protocol's `normalizeToolName` (which only lowercases) because task
 * detection collapses separators so "todo.write" / "todo-write" / "Todo Write"
 * all match "todo_write".
 */
function normalizeTaskToolName(toolName: string): string {
  return toolName
    .trim()
    .replace(/[.\s-]+/g, "_")
    .toLowerCase();
}

/**
 * Extract task entries (with full three-way status) from a task-list tool call.
 * Handles Claude's TodoWrite and Codex's UpdatePlan. Returns null when the tool
 * is not a task list. Shared by the daemon (to persist taskProgress) and the
 * app (to render the inline TodoListCard) so the two never drift.
 */
export function extractTaskEntriesFromToolCall(
  toolName: string,
  input: unknown,
): TaskEntry[] | null {
  const normalized = normalizeTaskToolName(toolName);

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

// ---------------------------------------------------------------------------
// Incremental (delta) task tools
//
// Full-list tools (TodoWrite / UpdatePlan, above) send the entire task array on
// every call, so they are stateless. Other harnesses — notably Claude Code's
// built-in TaskCreate / TaskUpdate — emit one task at a time as deltas, so the
// daemon must accumulate them per agent. This layer parses a single tool call
// into a TaskDelta and applies it to a running list.
// ---------------------------------------------------------------------------

/**
 * Accumulated list element. `id` is the harness's logical task id (assigned in
 * creation order: "1", "2", …) that TaskUpdate references. `callId` is the
 * timeline tool-call id used to dedupe a create that is recorded multiple times
 * (running → completed) so it doesn't append twice.
 */
export interface TaskEntryWithId {
  id: string;
  callId?: string;
  text: string;
  status: TaskStatus;
}

export type TaskDelta =
  | { kind: "create"; text: string; status: TaskStatus }
  | { kind: "update"; id: string; text?: string; status?: TaskStatus }
  | { kind: "delete"; id: string };

/** A tool whose calls are incremental task deltas rather than a full list. */
interface TaskDeltaToolAdapter {
  matches(normalizedName: string): boolean;
  parse(input: unknown): TaskDelta | null;
}

const ClaudeTaskCreateSchema = z.object({
  subject: z.string(),
  description: z.string().optional(),
  activeForm: z.string().optional(),
});

// TaskUpdate carries a "deleted" status in addition to the three-way set, which
// we translate into a delete delta.
const TaskUpdateStatusSchema = z.enum(["pending", "in_progress", "completed", "deleted"]);

const ClaudeTaskUpdateSchema = z.object({
  taskId: z.union([z.string(), z.number()]).optional(),
  id: z.union([z.string(), z.number()]).optional(),
  status: TaskUpdateStatusSchema.optional(),
  subject: z.string().optional(),
});

function toIdString(value: string | number | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const str = String(value).trim();
  return str.length ? str : null;
}

const claudeCodeTaskAdapter: TaskDeltaToolAdapter = {
  matches(normalizedName) {
    return (
      normalizedName === "taskcreate" ||
      normalizedName === "task_create" ||
      normalizedName === "taskupdate" ||
      normalizedName === "task_update"
    );
  },
  parse(input) {
    // A TaskUpdate is distinguished by carrying taskId/status; a TaskCreate
    // carries a subject. Check update first so a create that happens to omit a
    // subject (the transient "running" event has empty input) is not mistaken
    // for a create with empty text.
    const updated = ClaudeTaskUpdateSchema.safeParse(input);
    if (updated.success && (updated.data.taskId !== undefined || updated.data.id !== undefined)) {
      const id = toIdString(updated.data.taskId ?? updated.data.id);
      if (!id) {
        return null;
      }
      if (updated.data.status === "deleted") {
        return { kind: "delete", id };
      }
      const text = updated.data.subject?.trim();
      return {
        kind: "update",
        id,
        ...(text ? { text } : {}),
        ...(updated.data.status ? { status: updated.data.status } : {}),
      };
    }
    const created = ClaudeTaskCreateSchema.safeParse(input);
    if (created.success && created.data.subject.trim().length > 0) {
      const text = created.data.activeForm?.trim() || created.data.subject.trim();
      return { kind: "create", text, status: "pending" };
    }
    return null;
  },
};

const TASK_DELTA_ADAPTERS: TaskDeltaToolAdapter[] = [claudeCodeTaskAdapter];

/**
 * Parse a single tool call into a TaskDelta when it belongs to an incremental
 * task tool (e.g. Claude Code's TaskCreate/TaskUpdate). Returns null otherwise.
 * Adding a new incremental tool means adding one adapter — no daemon changes.
 */
export function extractTaskDeltaFromToolCall(toolName: string, input: unknown): TaskDelta | null {
  const normalized = normalizeTaskToolName(toolName);
  for (const adapter of TASK_DELTA_ADAPTERS) {
    if (adapter.matches(normalized)) {
      return adapter.parse(input);
    }
  }
  return null;
}

/**
 * Apply a single delta to a running task list. Pure: returns a new array.
 *
 * `callId` is the timeline tool-call id. The same TaskCreate call is recorded
 * multiple times (running → completed), so creates are deduped by `callId`:
 * the first occurrence appends with the next ordinal logical id ("1", "2", …),
 * and later occurrences of the same call update that entry's text in place.
 * TaskUpdate references the logical id via its `id`.
 * - create: append (deduped by callId); assign ordinal logical id.
 * - update: mutate text/status of the matching logical id; no-op if unknown.
 * - delete: drop the matching logical id.
 */
/** Next monotonic logical id: one past the highest numeric id in use. */
function nextTaskId(entries: TaskEntryWithId[]): number {
  let max = 0;
  for (const entry of entries) {
    const parsed = Number(entry.id);
    if (Number.isInteger(parsed) && parsed > max) {
      max = parsed;
    }
  }
  return max + 1;
}

export function applyTaskDelta(
  entries: TaskEntryWithId[],
  delta: TaskDelta,
  callId?: string,
): TaskEntryWithId[] {
  if (delta.kind === "create") {
    if (callId !== undefined) {
      const existingIndex = entries.findIndex((entry) => entry.callId === callId);
      if (existingIndex !== -1) {
        // Same create call recorded again (e.g. completed after running):
        // refresh its text/status rather than appending a duplicate.
        const next = [...entries];
        next[existingIndex] = {
          ...next[existingIndex],
          text: delta.text || next[existingIndex].text,
          status: delta.status,
        };
        return next;
      }
    }
    // Derive the next id from the max existing numeric id, never the list
    // length: after a delete the length shrinks and a length-based id would
    // collide with a surviving entry (delete "1" from ["1","2"] then create →
    // length 1 → "2", colliding with the survivor). Max-based ids stay unique.
    const id = String(nextTaskId(entries));
    const created: TaskEntryWithId = {
      id,
      ...(callId !== undefined ? { callId } : {}),
      text: delta.text,
      status: delta.status,
    };
    return [...entries, created];
  }
  if (delta.kind === "delete") {
    return entries.filter((entry) => entry.id !== delta.id);
  }
  let matched = false;
  const next = entries.map((entry) => {
    if (entry.id !== delta.id) {
      return entry;
    }
    matched = true;
    return {
      ...entry,
      ...(delta.text !== undefined ? { text: delta.text } : {}),
      ...(delta.status !== undefined ? { status: delta.status } : {}),
    };
  });
  return matched ? next : entries;
}

/** Build a TaskProgress snapshot from an accumulated (id-carrying) task list. */
export function taskEntriesToProgress(
  entries: TaskEntryWithId[],
  updatedAt: string,
): TaskProgressPayload {
  return buildTaskProgress(
    entries.map((entry) => ({
      text: entry.text,
      status: entry.status,
      completed: entry.status === "completed",
    })),
    updatedAt,
  );
}

/**
 * Aggregate task entries into a persisted TaskProgress snapshot with counts.
 * `updatedAt` is supplied by the caller (ISO string) so this stays pure.
 */
export function buildTaskProgress(entries: TaskEntry[], updatedAt: string): TaskProgressPayload {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  for (const entry of entries) {
    if (entry.status === "completed") {
      completed += 1;
    } else if (entry.status === "in_progress") {
      inProgress += 1;
    } else {
      pending += 1;
    }
  }
  return {
    items: entries.map((entry) => ({ text: entry.text, status: entry.status })),
    pending,
    inProgress,
    completed,
    total: entries.length,
    updatedAt,
  };
}
