import type { AgentTaskItem, AgentTimelineItem } from "../../agent-sdk-types.js";

type TaskToolName = "TodoWrite" | "TaskCreate" | "TaskUpdate" | "TaskList";

interface PendingTaskTool {
  name: TaskToolName;
  input: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function taskStatus(value: unknown): AgentTaskItem["status"] | "deleted" {
  if (value === "completed" || value === "deleted" || value === "in_progress") return value;
  return "pending";
}

function retainedTaskStatus(task: AgentTaskItem): AgentTaskItem["status"] {
  if (task.status) return task.status;
  return task.completed ? "completed" : "pending";
}

function toTaskItem(value: unknown): AgentTaskItem | null {
  const task = record(value);
  if (!task) return null;
  const text = string(task.subject) ?? string(task.content) ?? string(task.text);
  if (!text) return null;
  const status = taskStatus(task.status);
  if (status === "deleted") return null;
  const id = string(task.id) ?? string(task.taskId);
  const activeForm = string(task.activeForm) ?? string(task.active_form);
  return {
    ...(id ? { id } : {}),
    text,
    status,
    completed: status === "completed",
    ...(activeForm ? { activeForm } : {}),
  };
}

function toolUses(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const content = record(message.message)?.content;
  return Array.isArray(content)
    ? content.flatMap((block) => {
        const candidate = record(block);
        return candidate?.type === "tool_use" ? [candidate] : [];
      })
    : [];
}

function toolResultId(message: Record<string, unknown>): string | undefined {
  const content = record(message.message)?.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const candidate = record(block);
    if (candidate?.type === "tool_result") return string(candidate.tool_use_id);
  }
  return undefined;
}

function structuredResult(message: Record<string, unknown>): Record<string, unknown> | null {
  return record(message.toolUseResult) ?? record(message.tool_use_result);
}

/** Accumulates Claude's snapshot and ID-based task tools into canonical todo snapshots. */
export class ClaudeTaskState {
  private readonly tasks = new Map<string, AgentTaskItem>();
  private readonly calls = new Map<string, PendingTaskTool>();
  private readonly appliedResults = new Set<string>();

  observe(value: unknown): Extract<AgentTimelineItem, { type: "todo" }> | null {
    const message = record(value);
    if (!message) return null;

    let snapshot: Extract<AgentTimelineItem, { type: "todo" }> | null = null;
    for (const block of toolUses(message)) {
      const id = string(block.id);
      const name = string(block.name);
      if (!id || !isTaskToolName(name)) continue;
      const input = record(block.input) ?? {};
      this.calls.set(id, { name, input });
      if (name === "TodoWrite") snapshot = this.replaceLegacyTodos(input.todos);
    }

    const resultId = toolResultId(message);
    if (!resultId || this.appliedResults.has(resultId)) return snapshot;
    const call = this.calls.get(resultId);
    if (!call) return snapshot;
    this.appliedResults.add(resultId);
    this.calls.delete(resultId);
    return this.applyResult(call, structuredResult(message)) ?? snapshot;
  }

  reset(): void {
    this.tasks.clear();
    this.calls.clear();
    this.appliedResults.clear();
  }

  private replaceLegacyTodos(value: unknown): Extract<AgentTimelineItem, { type: "todo" }> {
    this.tasks.clear();
    if (Array.isArray(value)) {
      for (const [index, taskValue] of value.entries()) {
        const item = toTaskItem(taskValue);
        if (!item) continue;
        const id = item.id ?? `legacy:${index}`;
        this.tasks.set(id, { ...item, id });
      }
    }
    return this.snapshot();
  }

  private applyResult(
    call: PendingTaskTool,
    result: Record<string, unknown> | null,
  ): Extract<AgentTimelineItem, { type: "todo" }> | null {
    if (result?.success === false) return null;
    if (call.name === "TaskCreate") return this.applyCreate(call.input, result);
    if (call.name === "TaskUpdate") return this.applyUpdate(call.input, result);
    if (call.name === "TaskList") return this.applyList(result);
    return null;
  }

  private applyCreate(
    input: Record<string, unknown>,
    result: Record<string, unknown> | null,
  ): Extract<AgentTimelineItem, { type: "todo" }> | null {
    const resultTask = record(result?.task);
    const id = string(resultTask?.id) ?? string(result?.taskId);
    const text = string(resultTask?.subject) ?? string(input.subject);
    if (!id || !text) return null;
    const activeForm = string(input.activeForm);
    this.tasks.set(id, {
      id,
      text,
      status: "pending",
      completed: false,
      ...(activeForm ? { activeForm } : {}),
    });
    return this.snapshot();
  }

  private applyUpdate(
    input: Record<string, unknown>,
    result: Record<string, unknown> | null,
  ): Extract<AgentTimelineItem, { type: "todo" }> | null {
    const id = string(input.taskId) ?? string(result?.taskId);
    if (!id) return null;
    const current = this.tasks.get(id);
    if (!current) return null;
    const statusValue = input.status ?? record(result?.statusChange)?.to;
    const status =
      statusValue === undefined ? retainedTaskStatus(current) : taskStatus(statusValue);
    if (status === "deleted") {
      this.tasks.delete(id);
      return this.snapshot();
    }
    const text = string(input.subject);
    const activeForm = string(input.activeForm);
    this.tasks.set(id, {
      ...current,
      ...(text ? { text } : {}),
      ...(activeForm ? { activeForm } : {}),
      status,
      completed: status === "completed",
    });
    return this.snapshot();
  }

  private applyList(
    result: Record<string, unknown> | null,
  ): Extract<AgentTimelineItem, { type: "todo" }> | null {
    const tasks = result?.tasks;
    if (!Array.isArray(tasks)) return null;
    this.tasks.clear();
    for (const taskValue of tasks) {
      const item = toTaskItem(taskValue);
      if (item?.id) this.tasks.set(item.id, item);
    }
    return this.snapshot();
  }

  private snapshot(): Extract<AgentTimelineItem, { type: "todo" }> {
    return { type: "todo", items: [...this.tasks.values()] };
  }
}

function isTaskToolName(value: string | undefined): value is TaskToolName {
  return (
    value === "TodoWrite" ||
    value === "TaskCreate" ||
    value === "TaskUpdate" ||
    value === "TaskList"
  );
}
