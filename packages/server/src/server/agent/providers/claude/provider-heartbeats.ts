import type {
  ProviderHeartbeatDescriptor,
  ProviderHeartbeatMode,
  ProviderHeartbeatStore,
} from "../../provider-heartbeats/store.js";

export type ProviderHeartbeatInputEvent =
  | {
      kind: "upsert";
      task: ProviderHeartbeatDescriptor;
    }
  | {
      kind: "remove";
      taskId: string;
    }
  | {
      kind: "replace";
      tasks: ProviderHeartbeatDescriptor[];
    }
  | {
      kind: "clear";
    };

export interface ApplyProviderHeartbeatInputResult {
  changed: boolean;
  heartbeats: ProviderHeartbeatDescriptor[];
}

export interface ClaudeProviderHeartbeatToolPayload {
  toolName: string | null | undefined;
  toolInput: unknown;
  toolOutput: unknown;
}

const DYNAMIC_TASK_ID = "dynamic";

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

function toBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return null;
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

function unwrapToolOutputValue(toolOutput: unknown): unknown {
  if (toolOutput == null) return null;
  const top = asRecord(toolOutput);
  if (top?.output !== undefined) {
    if (typeof top.output === "string") {
      try {
        return JSON.parse(top.output) as unknown;
      } catch {
        return top.output;
      }
    }
    return top.output;
  }
  if (typeof toolOutput === "string") {
    try {
      return JSON.parse(toolOutput) as unknown;
    } catch {
      return toolOutput;
    }
  }
  return toolOutput;
}

function normalizeToolName(toolName: string | null | undefined): string {
  return (toolName ?? "").trim().toLowerCase().replace(/[_-]/g, "");
}

function readTaskId(record: Record<string, unknown> | null | undefined): string | null {
  if (!record) return null;
  return (
    toNonEmptyString(record.id) ??
    toNonEmptyString(record.jobId) ??
    toNonEmptyString(record.job_id) ??
    toNonEmptyString(record.taskId) ??
    toNonEmptyString(record.task_id)
  );
}

function readCron(record: Record<string, unknown> | null | undefined): string | null {
  if (!record) return null;
  return (
    toNonEmptyString(record.cron) ??
    toNonEmptyString(record.schedule) ??
    toNonEmptyString(record.expression)
  );
}

function readPrompt(record: Record<string, unknown> | null | undefined): string {
  if (!record) return "";
  return toNonEmptyString(record.prompt) ?? toNonEmptyString(record.message) ?? "";
}

function readRecurring(record: Record<string, unknown> | null | undefined): boolean {
  if (!record) return true;
  const recurring = toBoolean(record.recurring);
  if (recurring != null) return recurring;
  // Default CronCreate to recurring when omitted (Claude session schedules are usually recurring).
  return true;
}

function modeFromRecurring(recurring: boolean): ProviderHeartbeatMode {
  return recurring ? "recurring" : "one_shot";
}

function buildDescriptor(input: {
  taskId: string;
  prompt: string;
  mode: ProviderHeartbeatMode;
  scheduleLabel: string;
  nextHint: string | null;
  updatedAt: string;
}): ProviderHeartbeatDescriptor {
  return {
    taskId: input.taskId,
    // parentAgentId is filled by apply against the live parent.
    parentAgentId: "",
    provider: "claude",
    prompt: input.prompt,
    mode: input.mode,
    scheduleLabel: input.scheduleLabel,
    nextHint: input.nextHint,
    updatedAt: input.updatedAt,
  };
}

function mapCronCreate(
  toolInput: unknown,
  toolOutput: unknown,
  nowIso: string,
): ProviderHeartbeatInputEvent | null {
  const input = asRecord(toolInput);
  const outputRecords = collectToolOutputRecords(toolOutput);
  let taskId: string | null = null;
  for (const record of outputRecords) {
    taskId ??= readTaskId(record);
  }
  taskId ??= readTaskId(input);
  if (!taskId) return null;

  const cron = readCron(input) ?? "";
  const prompt = readPrompt(input);
  const recurring = readRecurring(input);
  return {
    kind: "upsert",
    task: buildDescriptor({
      taskId,
      prompt,
      mode: modeFromRecurring(recurring),
      scheduleLabel: cron || "cron",
      nextHint: null,
      updatedAt: nowIso,
    }),
  };
}

function mapCronDelete(toolInput: unknown): ProviderHeartbeatInputEvent | null {
  const input = asRecord(toolInput);
  const taskId = readTaskId(input);
  if (!taskId) return null;
  return { kind: "remove", taskId };
}

function mapCronListEntry(entry: unknown, nowIso: string): ProviderHeartbeatDescriptor | null {
  const record = asRecord(entry);
  if (!record) return null;
  const taskId = readTaskId(record);
  if (!taskId) return null;
  const cron = readCron(record) ?? "";
  const prompt = readPrompt(record);
  const recurring = readRecurring(record);
  return buildDescriptor({
    taskId,
    prompt,
    mode: modeFromRecurring(recurring),
    scheduleLabel: cron || "cron",
    nextHint: null,
    updatedAt: nowIso,
  });
}

function mapCronList(toolOutput: unknown, nowIso: string): ProviderHeartbeatInputEvent | null {
  const unwrapped = unwrapToolOutputValue(toolOutput);
  let entries: unknown[] | null = null;
  if (Array.isArray(unwrapped)) {
    entries = unwrapped;
  } else {
    const record = asRecord(unwrapped);
    if (record) {
      const nested =
        record.tasks ?? record.jobs ?? record.crons ?? record.items ?? record.heartbeats;
      if (Array.isArray(nested)) {
        entries = nested;
      }
    }
  }
  if (!entries) return null;

  const tasks: ProviderHeartbeatDescriptor[] = [];
  for (const entry of entries) {
    const mapped = mapCronListEntry(entry, nowIso);
    if (mapped) tasks.push(mapped);
  }
  return { kind: "replace", tasks };
}

function formatNextHint(input: {
  delaySeconds: number | null;
  reason: string | null;
}): string | null {
  const parts: string[] = [];
  if (input.delaySeconds != null && Number.isFinite(input.delaySeconds)) {
    parts.push(`in ${Math.round(input.delaySeconds)}s`);
  }
  if (input.reason) {
    parts.push(input.reason);
  }
  if (parts.length === 0) return null;
  return parts.join(" — ");
}

function mapScheduleWakeup(toolInput: unknown, nowIso: string): ProviderHeartbeatInputEvent | null {
  const input = asRecord(toolInput) ?? {};
  const stop = input.stop === true || input.stop === "true";
  if (stop) {
    return { kind: "remove", taskId: DYNAMIC_TASK_ID };
  }

  const delayRaw = input.delaySeconds ?? input.delay_seconds ?? input.delay;
  let delaySeconds: number | null = null;
  if (typeof delayRaw === "number") {
    delaySeconds = delayRaw;
  } else if (typeof delayRaw === "string" && delayRaw.trim().length > 0) {
    delaySeconds = Number(delayRaw);
  }
  const reason = toNonEmptyString(input.reason);
  const prompt = readPrompt(input) || "self-paced loop";

  return {
    kind: "upsert",
    task: buildDescriptor({
      taskId: DYNAMIC_TASK_ID,
      prompt,
      mode: "dynamic",
      scheduleLabel: "self-paced",
      nextHint: formatNextHint({
        delaySeconds: delaySeconds != null && Number.isFinite(delaySeconds) ? delaySeconds : null,
        reason,
      }),
      updatedAt: nowIso,
    }),
  };
}

export function mapClaudeProviderHeartbeatToolEvent(
  payload: ClaudeProviderHeartbeatToolPayload,
  nowIso: string,
): ProviderHeartbeatInputEvent | null {
  const name = normalizeToolName(payload.toolName);
  if (!name) return null;

  if (name === "croncreate") {
    return mapCronCreate(payload.toolInput, payload.toolOutput, nowIso);
  }
  if (name === "crondelete") {
    return mapCronDelete(payload.toolInput);
  }
  if (name === "cronlist") {
    return mapCronList(payload.toolOutput, nowIso);
  }
  if (name === "schedulewakeup") {
    return mapScheduleWakeup(payload.toolInput, nowIso);
  }
  return null;
}

export function applyProviderHeartbeatInputEvent(
  store: ProviderHeartbeatStore,
  parentAgentId: string,
  event: ProviderHeartbeatInputEvent,
): ApplyProviderHeartbeatInputResult {
  if (event.kind === "clear") {
    const before = store.list(parentAgentId);
    store.deleteParent(parentAgentId);
    return { changed: before.length > 0, heartbeats: [] };
  }

  const before = store.list(parentAgentId);

  if (event.kind === "remove") {
    const removed = store.remove(parentAgentId, event.taskId);
    const heartbeats = store.list(parentAgentId);
    return {
      changed: removed || JSON.stringify(before) !== JSON.stringify(heartbeats),
      heartbeats,
    };
  }

  if (event.kind === "replace") {
    const tasks = event.tasks.map((task) => ({
      ...task,
      parentAgentId,
    }));
    const heartbeats = store.replaceLiveSet(parentAgentId, tasks);
    return {
      changed: JSON.stringify(before) !== JSON.stringify(heartbeats),
      heartbeats,
    };
  }

  store.upsert(parentAgentId, {
    ...event.task,
    parentAgentId,
  });
  const heartbeats = store.list(parentAgentId);
  return {
    changed: JSON.stringify(before) !== JSON.stringify(heartbeats),
    heartbeats,
  };
}

export function applyClaudeProviderHeartbeatToolEvent(
  store: ProviderHeartbeatStore,
  parentAgentId: string,
  payload: ClaudeProviderHeartbeatToolPayload | { kind: "clear" },
  nowIso: string,
): ApplyProviderHeartbeatInputResult {
  if ("kind" in payload && payload.kind === "clear") {
    return applyProviderHeartbeatInputEvent(store, parentAgentId, { kind: "clear" });
  }
  const event = mapClaudeProviderHeartbeatToolEvent(
    payload as ClaudeProviderHeartbeatToolPayload,
    nowIso,
  );
  if (!event) {
    return { changed: false, heartbeats: store.list(parentAgentId) };
  }
  return applyProviderHeartbeatInputEvent(store, parentAgentId, event);
}
