import { computeNextRunAt } from "../../../schedule/cron.js";

const MINUTE_MS = 60_000;
/** Claude clamps ScheduleWakeup delays to this range. */
const MIN_WAKEUP_DELAY_S = 60;
const MAX_WAKEUP_DELAY_S = 3600;
/** Claude fires a recurring job up to 10% of its period late, capped at 15 minutes. */
const MAX_CRON_JITTER_MS = 15 * MINUTE_MS;
/** Session crons expire seven days after creation. */
const CRON_LIFETIME_MS = 7 * 24 * 60 * MINUTE_MS;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

type PendingCall =
  | { tool: "ScheduleWakeup"; delaySeconds: number | null; stop: boolean }
  | { tool: "CronCreate"; expression: string; recurring: boolean }
  | { tool: "CronDelete"; id: string };

interface CronWake {
  expression: string;
  recurring: boolean;
  dueAt: number;
  /** Claude's per-job jitter, kept so later runs land where Claude will fire them. */
  offsetMs: number;
  expiresAt: number;
}

/**
 * Wakes a Claude process will start on its own: a ScheduleWakeup (`/loop`) and session crons.
 * Claude reports neither through task events, so the due time is read from the tool result and a
 * fire from `command_lifecycle.wakeup_source`. Everything here dies with the process.
 */
export class ClaudeScheduledWakeups {
  private readonly calls = new Map<string, PendingCall>();
  private readonly crons = new Map<string, CronWake>();
  private loopDueAt: number | null = null;
  private published: string | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
  ) {}

  reset(): void {
    this.calls.clear();
    this.crons.clear();
    this.loopDueAt = null;
    this.published = null;
  }

  hasPending(): boolean {
    return this.loopDueAt !== null || this.crons.size > 0;
  }

  /** Returns the earliest wake time when it changes; `null` means nothing is scheduled. */
  observe(message: unknown): string | null | undefined {
    const record = asRecord(message);
    if (!record) return undefined;
    if (record.type === "assistant" && record.parent_tool_use_id == null) {
      this.observeToolUses(record);
      return undefined;
    }
    if (record.type === "user" && record.parent_tool_use_id == null)
      this.observeToolResults(record);
    else if (record.type === "command_lifecycle" && record.state === "started")
      this.observeFire(record.wakeup_source);
    else return undefined;
    const next = this.earliest();
    if (next === this.published) return undefined;
    this.published = next;
    return next;
  }

  private observeToolUses(message: Record<string, unknown>): void {
    for (const block of contentBlocks(message)) {
      if (block.type !== "tool_use" || typeof block.id !== "string") continue;
      const input = asRecord(block.input) ?? {};
      if (block.name === "ScheduleWakeup") {
        const delay = input.delaySeconds;
        this.calls.set(block.id, {
          tool: "ScheduleWakeup",
          delaySeconds: typeof delay === "number" && Number.isFinite(delay) ? delay : null,
          stop: input.stop === true,
        });
      } else if (block.name === "CronCreate" && typeof input.cron === "string") {
        this.calls.set(block.id, {
          tool: "CronCreate",
          expression: input.cron.trim(),
          recurring: input.recurring !== false,
        });
      } else if (block.name === "CronDelete" && typeof input.id === "string") {
        this.calls.set(block.id, { tool: "CronDelete", id: input.id.trim() });
      }
    }
  }

  private observeToolResults(message: Record<string, unknown>): void {
    for (const block of contentBlocks(message)) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const call = this.calls.get(block.tool_use_id);
      if (!call) continue;
      this.calls.delete(block.tool_use_id);
      if (block.is_error === true) continue;
      const text = resultText(block.content);
      if (call.tool === "ScheduleWakeup") this.applyWakeup(call, text);
      else if (call.tool === "CronCreate") this.applyCronCreate(call, text);
      else this.crons.delete(call.id);
    }
  }

  private applyWakeup(call: Extract<PendingCall, { tool: "ScheduleWakeup" }>, text: string): void {
    if (call.stop) {
      this.loopDueAt = null;
      return;
    }
    const seconds = wakeupDelaySeconds(call.delaySeconds, text);
    if (seconds !== null) this.loopDueAt = this.now() + seconds * 1000;
  }

  private applyCronCreate(call: Extract<PendingCall, { tool: "CronCreate" }>, text: string): void {
    const id = /\bjob ([\w-]+)/.exec(text)?.[1];
    if (!id) return;
    const now = this.now();
    const nominal = this.nextRun(call.expression, now);
    const reported = parseNextRun(text, now, this.timeZone);
    const dueAt = reported ?? nominal;
    if (dueAt === null) return;
    const offsetMs = reported !== null && nominal !== null ? reported - nominal : 0;
    this.crons.set(id, {
      expression: call.expression,
      recurring: call.recurring,
      dueAt,
      offsetMs: offsetMs > 0 && offsetMs <= MAX_CRON_JITTER_MS ? offsetMs : 0,
      expiresAt: now + CRON_LIFETIME_MS,
    });
  }

  private observeFire(source: unknown): void {
    if (source === "loop_wakeup") {
      this.loopDueAt = null;
      return;
    }
    if (source !== "schedule_wakeup") return;
    // The frame does not name the job; the earliest one is the one that came due.
    const [id, cron] =
      [...this.crons].sort((left, right) => left[1].dueAt - right[1].dueAt)[0] ?? [];
    if (!id || !cron) return;
    const nominal = cron.recurring ? this.nextRun(cron.expression, this.now()) : null;
    const dueAt = nominal === null ? null : nominal + cron.offsetMs;
    if (dueAt === null || dueAt > cron.expiresAt) this.crons.delete(id);
    else this.crons.set(id, { ...cron, dueAt });
  }

  private nextRun(expression: string, after: number): number | null {
    try {
      return computeNextRunAt(
        { type: "cron", expression, timezone: this.timeZone },
        new Date(after),
      ).getTime();
    } catch {
      return null;
    }
  }

  private earliest(): string | null {
    const times = [...this.crons.values()].map((cron) => cron.dueAt);
    if (this.loopDueAt !== null) times.push(this.loopDueAt);
    return times.length > 0 ? new Date(Math.min(...times)).toISOString() : null;
  }
}

/** Claude rounds the due time, so its "(in Ns)" is more precise than the requested delay. */
function wakeupDelaySeconds(requested: number | null, text: string): number | null {
  const reported = /\(in (\d+)s\)/.exec(text);
  if (reported) return Number(reported[1]);
  if (requested === null) return null;
  return Math.min(MAX_WAKEUP_DELAY_S, Math.max(MIN_WAKEUP_DELAY_S, requested));
}

/** Reads Claude's wall-clock "Next run: Nov 14 1:57am" as the nearest matching instant. */
function parseNextRun(text: string, now: number, timeZone: string): number | null {
  const match = /Next run: ([A-Za-z]{3})\w* (\d{1,2}),? (\d{1,2}):(\d{2})\s*([ap]m)?/i.exec(text);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1].toLowerCase());
  if (month < 0) return null;
  let hour = Number(match[3]);
  const meridiem = match[5]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  // The text has no year: take the first one that does not put the run in the past.
  const year = new Date(now).getUTCFullYear();
  for (const candidate of [year - 1, year, year + 1]) {
    const wall = Date.UTC(candidate, month, Number(match[2]), hour, Number(match[4]));
    const time = wall - zoneOffset(wall, timeZone);
    if (time >= now - MINUTE_MS) return time;
  }
  return null;
}

/** Milliseconds the zone's wall clock is ahead of UTC around `instant`. */
function zoneOffset(instant: number, timeZone: string): number {
  try {
    const parts: Record<string, number> = {};
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    for (const part of formatter.formatToParts(instant)) {
      if (part.type !== "literal") parts[part.type] = Number(part.value);
    }
    const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    return wall - Math.floor(instant / MINUTE_MS) * MINUTE_MS;
  } catch {
    return 0;
  }
}

function contentBlocks(message: Record<string, unknown>): Record<string, unknown>[] {
  const content = asRecord(message.message)?.content;
  return Array.isArray(content)
    ? content.map(asRecord).filter((block): block is Record<string, unknown> => block !== null)
    : [];
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => asRecord(part))
    .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
