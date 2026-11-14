import { computeNextRunAt, listCronRuns } from "../../../schedule/cron.js";

const MINUTE_MS = 60_000;
/** Claude clamps ScheduleWakeup delays to this range. */
const MIN_WAKEUP_DELAY_S = 60;
const MAX_WAKEUP_DELAY_S = 3600;
/**
 * How far Claude moves a cron run from its slot. Its scheduled-tasks docs: a recurring run starts
 * late by up to half its period and at most 30 minutes, a one-shot due at :00 or :30 up to 90 s
 * early. Runs of one job kept the same jitter, early or late: a `*\/5` job ran 26 s before its
 * slots, a `*\/2` job 56 s after them.
 */
const MAX_CRON_JITTER_MS = 30 * MINUTE_MS;
/**
 * Claude deletes a recurring session cron after its first run once the job is seven days old. It
 * removes nothing before a run.
 */
const CRON_LIFETIME_MS = 7 * 24 * 60 * MINUTE_MS;
/**
 * Claude runs a due wake once its turn is over, so one still unfired this long after both its time
 * and the end of the last turn is gone: for example a job that a subagent deleted, since subagent
 * calls are not followed here. It is then dropped, so it neither shows nor keeps the process alive.
 */
const LOST_AFTER_MS = MAX_CRON_JITTER_MS;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

type PendingCall =
  | { tool: "ScheduleWakeup"; delaySeconds: number | null; stop: boolean }
  | { tool: "CronCreate"; expression: string; recurring: boolean }
  | { tool: "CronDelete"; id: string };

interface CronWake {
  expression: string;
  recurring: boolean;
  createdAt: number;
  dueAt: number;
  /** Claude's per-job jitter (negative when early), so later runs land where Claude fires them. */
  offsetMs: number;
  /** The last fire may have been another job's, so the next one does not measure the jitter. */
  unsure: boolean;
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
  /**
   * When Claude's main session last finished a turn, or null while one runs. Read from the brackets
   * the session uses for mainTurnInFlight, plus the main session's own messages, since an idle state
   * can trail the previous turn and land in the next one.
   */
  private idleSince: number | null = null;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
  ) {}

  reset(): void {
    this.calls.clear();
    this.crons.clear();
    this.loopDueAt = null;
    this.published = null;
    this.idleSince = null;
  }

  hasPending(): boolean {
    return this.pendingTimes().length > 0;
  }

  /** Returns the earliest wake time when it changes; `null` means nothing is scheduled. */
  observe(message: unknown): string | null | undefined {
    const record = asRecord(message);
    if (!record) return undefined;
    // Dropped first, so that a fire cannot go to a job that is already gone.
    this.forgetLost();
    const mainSession = record.parent_tool_use_id == null;
    if (record.type === "assistant" && mainSession) {
      this.idleSince = null;
      this.observeToolUses(record);
    } else if (record.type === "user" && mainSession) {
      this.observeToolResults(record);
    } else if (record.type === "command_lifecycle" && record.state === "started") {
      this.idleSince = null;
      this.observeFire(record.wakeup_source);
    } else if (record.type === "system" && record.subtype === "init") {
      this.idleSince = null;
    } else if (endsTurn(record)) {
      this.idleSince ??= this.now();
    }
    return this.publish();
  }

  /**
   * When the earliest wake will count as lost, or null while none can be: Claude is in a turn or
   * nothing is scheduled. Nothing reports a loss, so the caller drops it then with dropLost().
   */
  nextLossAt(): number | null {
    const times = this.pendingTimes();
    if (this.idleSince === null || times.length === 0) return null;
    return Math.max(Math.min(...times), this.idleSince) + LOST_AFTER_MS;
  }

  /** Drops the lost wakes and returns the earliest wake time when it changes, as observe() does. */
  dropLost(): string | null | undefined {
    this.forgetLost();
    return this.publish();
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
    // Claude may skip a slot that its jitter already put in the past, so the reported run is
    // matched to its nearest slot, not to the next one.
    const reported = parseNextRun(text, now, this.timeZone);
    const dueAt = reported ?? this.nextRun(call.expression, now);
    if (dueAt === null) return;
    this.crons.set(id, {
      expression: call.expression,
      recurring: call.recurring,
      createdAt: now,
      dueAt,
      offsetMs: this.jitter(call.expression, dueAt) ?? 0,
      unsure: false,
    });
  }

  private observeFire(source: unknown): void {
    if (source === "loop_wakeup") {
      this.loopDueAt = null;
      return;
    }
    if (source !== "schedule_wakeup") return;
    // The frame does not name the job; the earliest one is the one that came due.
    const [first, ...others] = [...this.crons].sort(
      (left, right) => left[1].dueAt - right[1].dueAt,
    );
    if (!first) return;
    const [id, cron] = first;
    // Claude's "Next run" is rounded to the minute, so jobs due within a minute of each other cannot
    // be told apart by their fires: this one may be another's. It still advances the earliest job
    // but measures nothing, and neither does the next fire of the others.
    const twins = others.filter(([, other]) => other.dueAt - cron.dueAt < MINUTE_MS);
    for (const [twinId, twin] of twins) this.crons.set(twinId, { ...twin, unsure: true });
    const firedAt = this.now();
    if (!cron.recurring || firedAt - cron.createdAt >= CRON_LIFETIME_MS) {
      this.crons.delete(id);
      return;
    }
    // A fire within a minute of the expected time shows the job's jitter to the second. A later one
    // waited for a busy turn to end, so it shows none.
    const measurable =
      Math.abs(firedAt - cron.dueAt) < MINUTE_MS && twins.length === 0 && !cron.unsure;
    const offsetMs = (measurable ? this.jitter(cron.expression, firedAt) : null) ?? cron.offsetMs;
    // An early fire precedes the slot it was due for, and a late one may follow several slots: the
    // next run comes after both.
    const slot = Math.max(cron.dueAt - cron.offsetMs, firedAt - offsetMs);
    const nominal = this.nextRun(cron.expression, slot);
    if (nominal === null) this.crons.delete(id);
    else this.crons.set(id, { ...cron, dueAt: nominal + offsetMs, offsetMs, unsure: false });
  }

  /** How far `time` is from the expression's nearest slot, or null when no slot is close. */
  private jitter(expression: string, time: number): number | null {
    let nearest: number | null = null;
    for (const slot of this.slots(
      expression,
      time - MAX_CRON_JITTER_MS,
      time + MAX_CRON_JITTER_MS,
    )) {
      if (nearest === null || Math.abs(slot - time) < Math.abs(nearest - time)) nearest = slot;
    }
    return nearest === null ? null : time - nearest;
  }

  private nextRun(expression: string, after: number): number | null {
    // The expression is whatever Claude was asked to schedule; computeNextRunAt throws when it does
    // not parse or has no run within a year. Then there is no time to show.
    try {
      return computeNextRunAt(this.cadence(expression), new Date(after)).getTime();
    } catch {
      return null;
    }
  }

  private slots(expression: string, from: number, to: number): number[] {
    // As in nextRun, the expression may not parse.
    try {
      return listCronRuns(this.cadence(expression), new Date(from), new Date(to)).map((run) =>
        run.getTime(),
      );
    } catch {
      return [];
    }
  }

  private cadence(expression: string) {
    return { type: "cron" as const, expression, timezone: this.timeZone };
  }

  /** See LOST_AFTER_MS. */
  private isLost(dueAt: number): boolean {
    return this.idleSince !== null && this.now() >= Math.max(dueAt, this.idleSince) + LOST_AFTER_MS;
  }

  private forgetLost(): void {
    for (const [id, cron] of this.crons) if (this.isLost(cron.dueAt)) this.crons.delete(id);
    if (this.loopDueAt !== null && this.isLost(this.loopDueAt)) this.loopDueAt = null;
  }

  /** Due times of the wakes Claude still holds; a lost one may wait here for forgetLost(). */
  private pendingTimes(): number[] {
    const times = [...this.crons.values()].map((cron) => cron.dueAt);
    if (this.loopDueAt !== null) times.push(this.loopDueAt);
    return times.filter((time) => !this.isLost(time));
  }

  private publish(): string | null | undefined {
    const times = this.pendingTimes();
    const next = times.length > 0 ? new Date(Math.min(...times)).toISOString() : null;
    if (next === this.published) return undefined;
    this.published = next;
    return next;
  }
}

/** The main session's turn is over: its result, or Claude's own idle state. */
function endsTurn(record: Record<string, unknown>): boolean {
  if (record.type === "result") return true;
  return (
    record.type === "system" &&
    record.subtype === "session_state_changed" &&
    record.state === "idle"
  );
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
    const time = zonedInstant(wall, timeZone);
    if (time !== null && time >= now - MINUTE_MS) return time;
  }
  return null;
}

/** The instant a wall-clock time (given as if it were UTC) names in the zone, or null if none. */
function zonedInstant(wall: number, timeZone: string): number | null {
  // The offset depends on the instant being solved for. The offset at the wall time read as UTC is
  // a first guess, which is off by the change when a daylight-saving switch lies in between.
  const guess = wall - zoneOffset(wall, timeZone);
  const time = wall - zoneOffset(guess, timeZone);
  // A wall time that a switch skips maps back to another one.
  return time + zoneOffset(time, timeZone) === wall ? time : null;
}

/** Milliseconds the zone's wall clock is ahead of UTC around `instant`. */
function zoneOffset(instant: number, timeZone: string): number {
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
