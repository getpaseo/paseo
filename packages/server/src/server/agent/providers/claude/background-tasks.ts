import type {
  BackgroundTaskDescriptor,
  BackgroundTaskEnrichPatch,
  BackgroundTaskLiveMember,
  BackgroundTaskStatus,
  BackgroundTaskStore,
} from "../../background-tasks/store.js";
import { isShellTaskType } from "../../background-tasks/store.js";

export type BackgroundTaskInputEvent =
  | {
      kind: "replace";
      at: string;
      tasks: BackgroundTaskLiveMember[];
    }
  | {
      kind: "enrich";
      at: string;
      taskId: string;
      patch: BackgroundTaskEnrichPatch;
    }
  | {
      kind: "clear";
    };

export interface ApplyBackgroundTaskInputResult {
  changed: boolean;
  tasks: BackgroundTaskDescriptor[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function mapNotificationStatus(status: string | null): BackgroundTaskStatus | null {
  if (!status) return null;
  const normalized = status.trim().toLowerCase();
  if (normalized === "completed") return "completed";
  if (normalized === "failed") return "failed";
  if (normalized === "stopped" || normalized === "killed") return "stopped";
  if (normalized === "running" || normalized === "pending") return "running";
  return "unknown";
}

function mapPatchStatus(status: unknown): BackgroundTaskStatus | null {
  if (typeof status !== "string") return null;
  return mapNotificationStatus(status);
}

function mapBackgroundTasksChanged(
  record: Record<string, unknown>,
  nowIso: string,
): BackgroundTaskInputEvent {
  const rawTasks = Array.isArray(record.tasks) ? record.tasks : [];
  const tasks: BackgroundTaskLiveMember[] = [];
  for (const entry of rawTasks) {
    const task = asRecord(entry);
    if (!task) continue;
    const taskId = toNonEmptyString(task.task_id) ?? toNonEmptyString(task.taskId);
    if (!taskId) continue;
    const type = toNonEmptyString(task.task_type) ?? toNonEmptyString(task.type) ?? "unknown";
    const description =
      toNonEmptyString(task.description) ?? toNonEmptyString(task.command) ?? taskId;
    tasks.push({ taskId, type, description });
  }
  return { kind: "replace", at: nowIso, tasks };
}

function mapTaskStartedEvent(
  taskId: string,
  record: Record<string, unknown>,
  nowIso: string,
): BackgroundTaskInputEvent | null {
  const type = toNonEmptyString(record.task_type) ?? toNonEmptyString(record.type) ?? "shell";
  if (!isShellTaskType(type)) return null;
  const description = toNonEmptyString(record.description) ?? taskId;
  return {
    kind: "replace",
    at: nowIso,
    tasks: [{ taskId, type, description }],
  };
}

function mapTaskProgressEvent(
  taskId: string,
  record: Record<string, unknown>,
  nowIso: string,
): BackgroundTaskInputEvent | null {
  const summary = toNonEmptyString(record.summary) ?? toNonEmptyString(record.description);
  if (!summary) return null;
  return {
    kind: "enrich",
    at: nowIso,
    taskId,
    patch: {
      lastSummary: summary,
      description: toNonEmptyString(record.description) ?? undefined,
    },
  };
}

function mapTaskUpdatedEvent(
  taskId: string,
  record: Record<string, unknown>,
  nowIso: string,
): BackgroundTaskInputEvent | null {
  const patchRecord = asRecord(record.patch) ?? {};
  const status = mapPatchStatus(patchRecord.status);
  const description = toNonEmptyString(patchRecord.description);
  const patch: BackgroundTaskEnrichPatch = {};
  if (status) patch.status = status;
  if (description) patch.description = description;
  if (Object.keys(patch).length === 0) return null;
  return { kind: "enrich", at: nowIso, taskId, patch };
}

function mapTaskNotificationEvent(
  taskId: string,
  record: Record<string, unknown>,
  nowIso: string,
): BackgroundTaskInputEvent | null {
  const status = mapNotificationStatus(toNonEmptyString(record.status));
  const summary = toNonEmptyString(record.summary);
  const outputFile = toNonEmptyString(record.output_file) ?? toNonEmptyString(record.outputFile);
  const patch: BackgroundTaskEnrichPatch = {};
  if (status) patch.status = status;
  if (summary) patch.lastSummary = summary;
  if (outputFile) patch.outputFile = outputFile;
  if (Object.keys(patch).length === 0) return null;
  return { kind: "enrich", at: nowIso, taskId, patch };
}

export function applyBackgroundTaskInputEvent(
  store: BackgroundTaskStore,
  parentAgentId: string,
  event: BackgroundTaskInputEvent,
  nowIso: string,
): ApplyBackgroundTaskInputResult {
  if (event.kind === "clear") {
    const before = store.list(parentAgentId);
    store.deleteParent(parentAgentId);
    return { changed: before.length > 0, tasks: [] };
  }
  if (event.kind === "replace") {
    const before = store.list(parentAgentId);
    const tasks = store.replaceLiveSet(parentAgentId, event.tasks, event.at || nowIso);
    return {
      changed: JSON.stringify(before) !== JSON.stringify(tasks),
      tasks,
    };
  }

  const before = store.list(parentAgentId);
  const updated = store.enrich(parentAgentId, event.taskId, {
    ...event.patch,
    updatedAt: event.patch.updatedAt ?? event.at ?? nowIso,
  });
  const tasks = store.list(parentAgentId);
  return {
    changed: updated !== null || JSON.stringify(before) !== JSON.stringify(tasks),
    tasks,
  };
}

export function mapClaudeBackgroundSystemMessage(
  message: unknown,
  nowIso: string,
): BackgroundTaskInputEvent | null {
  const record = asRecord(message);
  if (!record || record.type !== "system") {
    return null;
  }
  const subtype = toNonEmptyString(record.subtype);
  if (!subtype) return null;

  if (subtype === "background_tasks_changed") {
    return mapBackgroundTasksChanged(record, nowIso);
  }

  const taskId = toNonEmptyString(record.task_id) ?? toNonEmptyString(record.taskId);
  if (!taskId) return null;

  switch (subtype) {
    case "task_started":
      return mapTaskStartedEvent(taskId, record, nowIso);
    case "task_progress":
      return mapTaskProgressEvent(taskId, record, nowIso);
    case "task_updated":
      return mapTaskUpdatedEvent(taskId, record, nowIso);
    case "task_notification":
      return mapTaskNotificationEvent(taskId, record, nowIso);
    default:
      return null;
  }
}

function collectToolOutputRecords(toolOutput: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const push = (value: unknown) => {
    const record = asRecord(value);
    if (record) {
      records.push(record);
      return;
    }
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value) as unknown;
        const parsedRecord = asRecord(parsed);
        if (parsedRecord) records.push(parsedRecord);
      } catch {
        // not JSON
      }
    }
  };
  push(toolOutput);
  const top = asRecord(toolOutput);
  if (top?.output !== undefined) {
    push(top.output);
  }
  return records;
}

function readBackgroundTaskId(record: Record<string, unknown>): string | null {
  return (
    toNonEmptyString(record.backgroundTaskId) ??
    toNonEmptyString(record.background_task_id) ??
    toNonEmptyString(record.task_id)
  );
}

export function extractBashBackgroundTaskCorrelation(input: {
  toolName: string | null | undefined;
  toolInput: unknown;
  toolOutput: unknown;
}): { taskId: string; command: string | null } | null {
  const name = (input.toolName ?? "").trim().toLowerCase();
  const isShell =
    name === "bash" ||
    name === "shell" ||
    name === "exec_command" ||
    name === "bash_code_execution";
  if (!isShell) return null;

  const outputRecords = collectToolOutputRecords(input.toolOutput);
  let taskId: string | null = null;
  let commandFromOutput: string | null = null;
  for (const record of outputRecords) {
    taskId ??= readBackgroundTaskId(record);
    commandFromOutput ??=
      toNonEmptyString(record.command) ?? toNonEmptyString(asRecord(record.input)?.command);
  }
  if (!taskId) return null;

  const toolInput = asRecord(input.toolInput);
  const command = toNonEmptyString(toolInput?.command) ?? commandFromOutput;
  return { taskId, command };
}

function applyTaskStartedWithoutWipe(
  store: BackgroundTaskStore,
  parentAgentId: string,
  event: Extract<BackgroundTaskInputEvent, { kind: "replace" }>,
  nowIso: string,
): ApplyBackgroundTaskInputResult {
  const only = event.tasks[0];
  if (!only) {
    return { changed: false, tasks: store.list(parentAgentId) };
  }
  const existing = store.get(parentAgentId, only.taskId);
  if (existing) {
    return applyBackgroundTaskInputEvent(
      store,
      parentAgentId,
      {
        kind: "enrich",
        at: nowIso,
        taskId: only.taskId,
        patch: { description: only.description, type: only.type, status: "running" },
      },
      nowIso,
    );
  }
  const merged = [
    ...store.list(parentAgentId).map((row) => ({
      taskId: row.taskId,
      type: row.type,
      description: row.description,
    })),
    only,
  ];
  return applyBackgroundTaskInputEvent(
    store,
    parentAgentId,
    { kind: "replace", at: nowIso, tasks: merged },
    nowIso,
  );
}

export function applyClaudeBackgroundSystemMessage(
  store: BackgroundTaskStore,
  parentAgentId: string,
  message: unknown,
  nowIso: string,
): ApplyBackgroundTaskInputResult {
  const event = mapClaudeBackgroundSystemMessage(message, nowIso);
  if (!event) {
    return { changed: false, tasks: store.list(parentAgentId) };
  }
  if (
    event.kind === "replace" &&
    asRecord(message)?.subtype === "task_started" &&
    event.tasks.length === 1
  ) {
    return applyTaskStartedWithoutWipe(store, parentAgentId, event, nowIso);
  }
  return applyBackgroundTaskInputEvent(store, parentAgentId, event, nowIso);
}
