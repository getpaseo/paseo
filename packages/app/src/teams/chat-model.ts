import type {
  TeamBindingSummary,
  TeamEventPayload,
  TeamSummary,
} from "@getpaseo/protocol/messages";

export type TeamMemberTone = "po" | "developer" | "tester" | "reviewer" | "boss" | "other";

export type TeamChatRow =
  | { kind: "day"; key: string; label: string }
  | { kind: "system"; key: string; text: string; time: string; attention: boolean }
  | {
      kind: "bubble";
      key: string;
      mine: boolean;
      author: string;
      tone: TeamMemberTone;
      subtitle: string | null;
      text: string;
      time: string;
      agentId: string | null;
      pending: boolean;
    };

/** A message the person sent that the event log has not returned yet. */
export interface PendingTeamMessage {
  id: string;
  text: string;
  at: string;
}

const ROLE_LABELS: Record<string, string> = {
  po: "PO",
  developer: "Developer",
  tester: "Tester",
  reviewer: "Reviewer",
};

const KNOWN_TONES = new Set<TeamMemberTone>(["po", "developer", "tester", "reviewer"]);

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function formatTeamTime(at: string): string {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatTeamDay(at: string, now: Date): string {
  const date = new Date(at);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(date) === dayKey(now)) return "Today";
  if (dayKey(date) === dayKey(yesterday)) return "Yesterday";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role.charAt(0).toUpperCase() + role.slice(1);
}

function stringField(data: TeamEventPayload["data"], key: string): string | null {
  const value = data?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface MemberBubble {
  mine: boolean;
  author: string;
  tone: TeamMemberTone;
  agentId: string | null;
}

// Team members speak in bubbles; phase moves, seats starting, restarts, health and Jev are system lines.
function memberOf(
  event: TeamEventPayload,
  team: TeamSummary,
  agentByBinding: Map<string, string>,
): MemberBubble | null {
  const { actor } = event;
  if (actor.type === "human") {
    const mine = actor.id === "user";
    return { mine, author: mine ? "You" : actor.id, tone: "other", agentId: null };
  }
  if (actor.type === "boss" && event.type === "human.message") {
    return { mine: false, author: "Boss", tone: "boss", agentId: team.bossAgentId };
  }
  if (
    actor.type === "role" &&
    (event.type.startsWith("report.") || event.type.startsWith("plan."))
  ) {
    const bindingId = stringField(event.data, "bindingId");
    const agentId =
      stringField(event.data, "agentId") ?? (bindingId ? agentByBinding.get(bindingId) : null);
    const tone = KNOWN_TONES.has(actor.id as TeamMemberTone)
      ? (actor.id as TeamMemberTone)
      : "other";
    return { mine: false, author: roleLabel(actor.id), tone, agentId: agentId ?? null };
  }
  return null;
}

export function buildTeamChatRows(input: {
  team: TeamSummary;
  events: readonly TeamEventPayload[];
  bindings: readonly TeamBindingSummary[];
  pending: readonly PendingTeamMessage[];
  now: Date;
}): TeamChatRow[] {
  const itemTitles = new Map(input.team.items.map((item) => [item.id, item.title]));
  const agentByBinding = new Map(input.bindings.map((binding) => [binding.id, binding.agentId]));
  const rows: TeamChatRow[] = [];
  let lastDay: string | null = null;

  function pushDay(at: string): void {
    const day = dayKey(new Date(at));
    if (day === lastDay) return;
    lastDay = day;
    rows.push({ kind: "day", key: `day:${day}`, label: formatTeamDay(at, input.now) });
  }

  input.events.forEach((event, index) => {
    pushDay(event.at);
    const key = `event:${event.commit}:${index}`;
    const member = memberOf(event, input.team, agentByBinding);
    if (!member) {
      rows.push({
        kind: "system",
        key,
        text: event.text,
        time: formatTeamTime(event.at),
        attention: event.type === "boss.notified",
      });
      return;
    }
    const itemTitle = event.workItemId ? (itemTitles.get(event.workItemId) ?? null) : null;
    rows.push({
      kind: "bubble",
      key,
      ...member,
      subtitle: member.mine ? null : itemTitle,
      text: event.text,
      time: formatTeamTime(event.at),
      pending: false,
    });
  });

  for (const message of input.pending) {
    pushDay(message.at);
    rows.push({
      kind: "bubble",
      key: `pending:${message.id}`,
      mine: true,
      author: "You",
      tone: "other",
      subtitle: null,
      text: message.text,
      time: formatTeamTime(message.at),
      agentId: null,
      pending: true,
    });
  }
  return rows;
}
