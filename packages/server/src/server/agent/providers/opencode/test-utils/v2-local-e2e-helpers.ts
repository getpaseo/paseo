import { z } from "zod";
import type {
  AgentPermissionRequest,
  AgentSession,
  AgentSlashCommand,
  AgentStreamEvent,
  AgentTimelineItem,
} from "../../../agent-sdk-types.js";

export function requireSessionId(session: { id: string | null }): string {
  if (!session.id) throw new Error("OpenCode session has no id");
  return session.id;
}

export function readAssistantText(
  timeline: ReadonlyArray<Pick<AgentTimelineItem, "type"> & { text?: string }>,
): string {
  return timeline
    .flatMap((item) => (item.type === "assistant_message" ? [item.text ?? ""] : []))
    .join("");
}

export function requireNativeUserMessageId(timeline: readonly AgentTimelineItem[]): string {
  const user = timeline.find((item) => item.type === "user_message");
  if (!user || user.type !== "user_message" || !user.messageId)
    throw new Error("Missing native user message ID");
  return user.messageId;
}

export function findSkillCommand(
  commands: readonly AgentSlashCommand[],
  nameFragment: string,
): AgentSlashCommand {
  const skill = commands.find((item) => item.kind === "skill" && item.name.includes(nameFragment));
  if (!skill) throw new Error(`Missing skill command matching ${nameFragment}`);
  return skill;
}

/** Live assistant text as it streams, so tests never spell out the event filter. */
export function collectStreamedAssistantText(session: AgentSession): string[] {
  const text: string[] = [];
  session.subscribe((event) => {
    if (event.type === "timeline" && event.item.type === "assistant_message")
      text.push(event.item.text);
  });
  return text;
}

export function drainPersistedTimeline(session: AgentSession): Promise<AgentStreamEvent[]> {
  return drain(session);
}

async function drain(session: AgentSession): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of session.streamHistory()) events.push(event);
  return events;
}

/** Assistant text replayed from persisted history. */
export async function drainPersistedAssistantText(session: AgentSession): Promise<string[]> {
  return (await drainPersistedTimeline(session)).flatMap((event) =>
    event.type === "timeline" && event.item.type === "assistant_message" ? [event.item.text] : [],
  );
}

export function collectRunningToolCalls(session: AgentSession) {
  let running = false;
  let canceledTurns = 0;
  session.subscribe((event) => {
    if (event.type === "turn_canceled") canceledTurns += 1;
    if (
      event.type === "timeline" &&
      event.item.type === "tool_call" &&
      event.item.status === "running"
    )
      running = true;
  });
  return {
    hasRunningTool: () => running,
    canceledTurns: () => canceledTurns,
  };
}

export function collectPermissions(session: AgentSession): string[] {
  const names: string[] = [];
  session.subscribe((event) => {
    if (event.type === "permission_requested") names.push(event.request.name);
  });
  return names;
}

interface AutoRespondOptions {
  /** Answer value applied to every question header. */
  questionAnswer?: string;
}

/**
 * Answers provider permissions as they arrive: questions with the configured
 * answer, tools with a one-time approval. Tests assert the collected kinds and
 * errors instead of branching on permission type.
 */
export function autoRespondToPermissions(session: AgentSession, options: AutoRespondOptions = {}) {
  const kinds: string[] = [];
  const errors: unknown[] = [];
  session.subscribe((event) => {
    if (event.type !== "permission_requested") return;
    kinds.push(event.request.kind);
    void respondToRequest(session, event.request, options).catch((error: unknown) => {
      errors.push(error);
    });
  });
  return { kinds, errors };
}

function respondToRequest(
  session: AgentSession,
  request: AgentPermissionRequest,
  options: AutoRespondOptions,
): Promise<void> {
  if (request.kind !== "question") {
    return session.respondToPermission(request.id, {
      behavior: "allow",
      selectedActionId: "once",
    });
  }
  const input = z
    .object({ questions: z.array(z.object({ header: z.string() })) })
    .parse(request.input);
  return session.respondToPermission(request.id, {
    behavior: "allow",
    updatedInput: {
      answers: Object.fromEntries(
        input.questions.map((question) => [question.header, options.questionAnswer ?? "Blue"]),
      ),
    },
  });
}

export function collectProviderSubagents(session: AgentSession) {
  let completed = false;
  let text = "";
  session.subscribe((event) => {
    if (event.type !== "provider_subagent") return;
    if (event.event.type === "upsert" && event.event.status === "completed") completed = true;
    if (event.event.type === "timeline" && event.event.item.type === "assistant_message")
      text += event.event.item.text;
  });
  return {
    hasCompletedChild: () => completed,
    childText: () => text,
  };
}
