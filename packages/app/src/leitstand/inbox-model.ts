import {
  isSessionMarkedDone,
  type LeitstandPullRequest,
  type LeitstandSchedule,
  type LeitstandSession,
} from "./session-model";

/**
 * Why something needs you, most urgent kind first. The inbox is derived from live session,
 * change-request and schedule data on every render; nothing here is stored, so an item leaves
 * the moment its reason does. Looking at a session is never a reason to leave: a question or a
 * handed-back turn stays until the person replies or marks the session done.
 */
export type InboxKind =
  | "permission"
  | "question"
  | "agent_error"
  | "schedule_error"
  | "checks_failed"
  | "merge_ready"
  | "finished";

const KIND_RANK: Record<InboxKind, number> = {
  permission: 0,
  question: 1,
  agent_error: 2,
  schedule_error: 3,
  checks_failed: 4,
  merge_ready: 5,
  finished: 6,
};

interface InboxItemBase {
  /**
   * Identity of this reason: session (or schedule) + kind + what makes the reason this one. A
   * snooze is stored against it, so a new question or another failing run surfaces again.
   */
  id: string;
  serverId: string;
  projectName: string | null;
  title: string;
  since: Date | null;
}

export interface SessionInboxItemBase extends InboxItemBase {
  sessionKey: string;
  workspaceId: string;
}

export interface PermissionInboxItem extends SessionInboxItemBase {
  kind: "permission";
  agentId: string;
  agentLabel: string;
  request: string;
}

export interface QuestionInboxItem extends SessionInboxItemBase {
  kind: "question";
  agentId: string | null;
}

export interface AgentErrorInboxItem extends SessionInboxItemBase {
  kind: "agent_error";
  agentId: string | null;
  error: string | null;
}

export interface ChecksFailedInboxItem extends SessionInboxItemBase {
  kind: "checks_failed";
  pullRequest: LeitstandPullRequest;
  failingCount: number;
}

export interface MergeReadyInboxItem extends SessionInboxItemBase {
  kind: "merge_ready";
  pullRequest: LeitstandPullRequest;
}

/** An agent handed the turn back and nobody replied or marked the session done. */
export interface FinishedInboxItem extends SessionInboxItemBase {
  kind: "finished";
  /** The agent that spoke last; its reply is the row's context and where a reply goes. */
  agentId: string | null;
}

export interface ScheduleErrorInboxItem extends InboxItemBase {
  kind: "schedule_error";
  scheduleId: string;
  /** Workspace the failed run worked in, when the daemon reports it. */
  workspaceId: string | null;
  error: string | null;
}

export type SessionInboxItem =
  | PermissionInboxItem
  | QuestionInboxItem
  | AgentErrorInboxItem
  | ChecksFailedInboxItem
  | MergeReadyInboxItem
  | FinishedInboxItem;

export type InboxItem = SessionInboxItem | ScheduleErrorInboxItem;

function sinceKey(since: Date | null): string {
  return since ? String(since.getTime()) : "";
}

function isOpen(pr: LeitstandPullRequest): boolean {
  return pr.state === "open";
}

// ponytail: sessions handed back longer ago than this stay on the board's "waiting" column but
// leave the inbox, so years of untouched workspaces do not bury today's; a per-session
// "seen" marker on the daemon would replace the window if that ever reads wrong.
export const WAITING_INBOX_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

function isHandedBackRecently(session: LeitstandSession, nowMs: number): boolean {
  if (session.agents.length === 0 || !session.handedBackAt) return false;
  if (isSessionMarkedDone(session)) return false;
  return nowMs - session.handedBackAt.getTime() <= WAITING_INBOX_WINDOW_MS;
}

function latestAgentId(session: LeitstandSession): string | null {
  let latest: LeitstandSession["agents"][number] | null = null;
  for (const agent of session.agents) {
    if (!latest || agent.lastActivityAt > latest.lastActivityAt) latest = agent;
  }
  return latest?.id ?? null;
}

function sessionItems(session: LeitstandSession, nowMs: number): SessionInboxItem[] {
  const base = {
    serverId: session.serverId,
    sessionKey: session.key,
    workspaceId: session.workspaceId,
    projectName: session.projectName,
    title: session.name,
    since: session.since,
  };
  const items: SessionInboxItem[] = [];

  if (session.bucket === "needs_input") {
    const asking = session.agents.find((agent) => agent.pendingPermission !== null);
    if (asking?.pendingPermission) {
      items.push({
        ...base,
        kind: "permission",
        id: `${session.key}|permission|${asking.pendingPermission.id}`,
        agentId: asking.id,
        agentLabel: asking.title ?? asking.provider,
        request: asking.pendingPermission.title,
      });
    } else if (!isSessionMarkedDone(session)) {
      items.push({
        ...base,
        kind: "question",
        id: `${session.key}|question|${sinceKey(base.since)}`,
        agentId: latestAgentId(session),
      });
    }
  }

  if (session.bucket === "failed") {
    const failed = session.agents.find((agent) => agent.bucket === "failed");
    items.push({
      ...base,
      kind: "agent_error",
      id: `${session.key}|agent_error|${sinceKey(base.since)}`,
      agentId: failed?.id ?? null,
      error: failed?.lastError ?? null,
    });
  }

  if (
    (session.bucket === "attention" || session.bucket === "done") &&
    isHandedBackRecently(session, nowMs)
  ) {
    items.push({
      ...base,
      since: session.handedBackAt,
      kind: "finished",
      id: `${session.key}|finished|${sinceKey(session.handedBackAt)}`,
      agentId: latestAgentId(session),
    });
  }

  const open = session.pullRequests.filter(isOpen);
  const failing = open.filter((pr) => pr.checksStatus === "failure");
  const [firstFailing] = failing;
  if (firstFailing) {
    items.push({
      ...base,
      since: null,
      kind: "checks_failed",
      id: `${session.key}|checks_failed|${failing.map((pr) => pr.number).join(",")}`,
      pullRequest: firstFailing,
      failingCount: failing.length,
    });
  }

  // In a stack only the lowest open layer can merge; the ones above wait on it.
  const [lowestOpen] = open;
  if (lowestOpen && !lowestOpen.isDraft && lowestOpen.checksStatus === "success") {
    items.push({
      ...base,
      since: null,
      kind: "merge_ready",
      id: `${session.key}|merge_ready|${lowestOpen.number}`,
      pullRequest: lowestOpen,
    });
  }

  return items;
}

function scheduleItem(entry: LeitstandSchedule): ScheduleErrorInboxItem | null {
  const lastRun = entry.schedule.lastRun;
  if (lastRun?.status !== "failed") return null;
  return {
    kind: "schedule_error",
    id: `${entry.key}|schedule_error|${lastRun.id}`,
    serverId: entry.serverId,
    scheduleId: entry.schedule.id,
    workspaceId: lastRun.workspaceId ?? null,
    projectName: entry.projectName,
    title: entry.schedule.name ?? entry.schedule.prompt,
    since: new Date(lastRun.endedAt ?? lastRun.startedAt),
    error: lastRun.error,
  };
}

function compareItems(left: InboxItem, right: InboxItem): number {
  const rank = KIND_RANK[left.kind] - KIND_RANK[right.kind];
  if (rank !== 0) return rank;
  // Within a kind, whoever has waited longest comes first.
  const leftTime = left.since?.getTime() ?? Infinity;
  const rightTime = right.since?.getTime() ?? Infinity;
  if (leftTime !== rightTime) return leftTime - rightTime;
  return left.id.localeCompare(right.id);
}

export interface LeitstandInbox {
  items: InboxItem[];
  /** Hidden by an active snooze; they come back on their own. */
  snoozedCount: number;
  /** When the next snooze runs out, so the caller knows when to look again. Null if none. */
  nextWakeAt: number | null;
}

export function buildLeitstandInbox(input: {
  sessions: readonly LeitstandSession[];
  schedules: readonly LeitstandSchedule[];
  snoozedUntil: Readonly<Record<string, number>>;
  nowMs: number;
}): LeitstandInbox {
  const all: InboxItem[] = input.sessions.flatMap((session) => sessionItems(session, input.nowMs));
  for (const schedule of input.schedules) {
    const item = scheduleItem(schedule);
    if (item) all.push(item);
  }

  const items: InboxItem[] = [];
  let snoozedCount = 0;
  let nextWakeAt: number | null = null;
  for (const item of all) {
    const until = input.snoozedUntil[item.id];
    if (until !== undefined && until > input.nowMs) {
      snoozedCount += 1;
      nextWakeAt = nextWakeAt === null ? until : Math.min(nextWakeAt, until);
    } else {
      items.push(item);
    }
  }
  items.sort(compareItems);
  return { items, snoozedCount, nextWakeAt };
}

export type SnoozeOption = "hour" | "evening" | "morning";

const EVENING_HOUR = 18;
const MORNING_HOUR = 8;

/** The next time the local clock reads `hour`:00 strictly after `now`. */
function nextLocalHour(now: Date, hour: number): Date {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/** "Tonight" only makes sense before the evening has started. */
export function availableSnoozeOptions(now: Date): SnoozeOption[] {
  return now.getHours() < EVENING_HOUR ? ["hour", "evening", "morning"] : ["hour", "morning"];
}

export function snoozeUntil(option: SnoozeOption, now: Date): Date {
  switch (option) {
    case "hour":
      return new Date(now.getTime() + 60 * 60 * 1000);
    case "evening":
      return nextLocalHour(now, EVENING_HOUR);
    case "morning":
      return nextLocalHour(now, MORNING_HOUR);
  }
}

export type PandaMood = "run" | "ask" | "err" | "sleep";

const ERROR_KINDS: ReadonlySet<InboxKind> = new Set([
  "agent_error",
  "schedule_error",
  "checks_failed",
]);
const ASK_KINDS: ReadonlySet<InboxKind> = new Set(["permission", "question", "merge_ready"]);

/** Startled by errors, paw up while a decision waits on you, chewing while agents work. */
export function deriveLeitstandMood(input: {
  items: readonly InboxItem[];
  runningAgentCount: number;
}): PandaMood {
  if (input.items.some((item) => ERROR_KINDS.has(item.kind))) return "err";
  if (input.items.some((item) => ASK_KINDS.has(item.kind))) return "ask";
  if (input.runningAgentCount > 0) return "run";
  // Sleeping means nothing needs you, so an unread result keeps the paw up.
  return input.items.length > 0 ? "ask" : "sleep";
}
