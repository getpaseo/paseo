import type pino from "pino";
import type { AgentAttentionNotificationPayload } from "@getpaseo/protocol/agent-attention-notification";
import type { WorkspaceHandoff } from "./handoff-classifier.js";

// The same payload as an attention notification, so a tap opens the session the usual way.
export type HandoffPingNotification = AgentAttentionNotificationPayload;

export interface HandoffPingInput {
  serverId: string;
  workspaceId: string;
  handoff: WorkspaceHandoff;
  projectName: string | null;
  /** When the person last wrote in this session; a ping waits for it after the previous one. */
  lastUserMessageAt: Date | null;
}

const PINGED_KINDS = new Set(["question", "action"]);
const MORNING_BODY_LIMIT = 3;

/** The hour on the wall clock in `timeZone`, 0–23. */
export function localHour(date: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone })
    .formatToParts(date)
    .find((part) => part.type === "hour")?.value;
  return Number(hour ?? "0");
}

export function isQuietHour(date: Date, timeZone: string, quiet: { from: number; to: number }) {
  const hour = localHour(date, timeZone);
  return quiet.from > quiet.to
    ? hour >= quiet.from || hour < quiet.to
    : hour >= quiet.from && hour < quiet.to;
}

/** Milliseconds until the quiet window in `timeZone` ends, checked in 15-minute steps. */
export function msUntilQuietEnds(
  now: Date,
  timeZone: string,
  quiet: { from: number; to: number },
): number {
  const step = 15 * 60 * 1000;
  for (let offset = step; offset <= 24 * 60 * 60 * 1000; offset += step) {
    if (!isQuietHour(new Date(now.getTime() + offset), timeZone, quiet)) {
      const target = new Date(now.getTime() + offset);
      target.setMinutes(0, 0, 0);
      return Math.max(target.getTime() - now.getTime(), 0);
    }
  }
  return step;
}

/**
 * Pings the person when a sorted handback asks them something: once per session until they
 * answer, and never at night, when pings wait for one morning summary.
 */
export class HandoffPinger {
  private readonly pingedAt = new Map<string, number>();
  private readonly waitingForMorning = new Map<string, HandoffPingNotification>();
  private morningTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(
    private readonly options: {
      deliver: (notification: HandoffPingNotification & { agentId: string }) => Promise<void>;
      sendMorningSummary: (notification: HandoffPingNotification) => Promise<void>;
      logger: pino.Logger;
      timeZone?: string;
      quiet?: { from: number; to: number };
      now?: () => Date;
      setTimer?: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
    },
  ) {}

  public notify(input: HandoffPingInput): void {
    if (!PINGED_KINDS.has(input.handoff.kind)) return;
    const previous = this.pingedAt.get(input.workspaceId);
    const answered = input.lastUserMessageAt?.getTime() ?? 0;
    if (previous !== undefined && answered <= previous) return;
    const now = this.now();
    this.pingedAt.set(input.workspaceId, now.getTime());
    const notification = pingFor(input);
    if (isQuietHour(now, this.timeZone(), this.quiet())) {
      this.waitingForMorning.set(input.workspaceId, notification);
      this.scheduleMorning(now);
      return;
    }
    void this.options
      .deliver({ ...notification, agentId: input.handoff.agentId })
      .catch((error: unknown) => this.options.logger.warn({ err: error }, "handoff ping failed"));
  }

  private scheduleMorning(now: Date): void {
    if (this.morningTimer) return;
    const setTimer = this.options.setTimer ?? ((run, ms) => setTimeout(run, ms).unref());
    this.morningTimer = setTimer(
      () => {
        this.morningTimer = null;
        void this.flushMorning();
      },
      msUntilQuietEnds(now, this.timeZone(), this.quiet()),
    );
  }

  private async flushMorning(): Promise<void> {
    const waiting = [...this.waitingForMorning.values()];
    this.waitingForMorning.clear();
    const [first] = waiting;
    if (!first) return;
    const lines = waiting.slice(0, MORNING_BODY_LIMIT).map((ping) => `${ping.title}: ${ping.body}`);
    if (waiting.length > MORNING_BODY_LIMIT) lines.push(`+${waiting.length - MORNING_BODY_LIMIT}`);
    await this.options
      .sendMorningSummary({
        title: waiting.length === 1 ? first.title : `${waiting.length} sessions wait for you`,
        body: waiting.length === 1 ? first.body : lines.join("\n"),
        data: first.data,
      })
      .catch((error: unknown) => this.options.logger.warn({ err: error }, "morning ping failed"));
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private timeZone(): string {
    return this.options.timeZone ?? "Europe/Berlin";
  }

  private quiet(): { from: number; to: number } {
    return this.options.quiet ?? { from: 22, to: 7 };
  }
}

function pingFor(input: HandoffPingInput): HandoffPingNotification {
  const fallback = input.handoff.kind === "question" ? "has a question for you" : "needs you";
  return {
    title: input.projectName ?? "PandaOS",
    body: input.handoff.need ?? fallback,
    data: {
      serverId: input.serverId,
      workspaceId: input.workspaceId,
      agentId: input.handoff.agentId,
      reason: "finished",
    },
  };
}
