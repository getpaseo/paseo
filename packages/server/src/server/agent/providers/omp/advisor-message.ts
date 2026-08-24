import { createHash } from "node:crypto";

import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import type { OmpAgentMessage } from "./rpc-types.js";

type OmpCustomMessage = Extract<OmpAgentMessage, { role: "custom" }>;
type OmpAdvisorToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;
type OmpAdvisorSeverity = "nit" | "concern" | "blocker";

interface OmpAdvisorNote {
  note: string;
  severity?: OmpAdvisorSeverity;
  advisor?: string;
}

const ADVISOR_SEVERITIES: Record<OmpAdvisorSeverity, true> = {
  nit: true,
  concern: true,
  blocker: true,
};

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readAdvisorNotes(message: OmpCustomMessage): OmpAdvisorNote[] {
  const details = Reflect.get(message, "details");
  if (!details || typeof details !== "object") return [];
  const notes = Reflect.get(details, "notes");
  if (!Array.isArray(notes)) return [];

  return notes.flatMap((value): OmpAdvisorNote[] => {
    if (!value || typeof value !== "object") return [];
    const note = readOptionalString(Reflect.get(value, "note"));
    if (!note) return [];
    const rawSeverity = Reflect.get(value, "severity");
    const severity =
      typeof rawSeverity === "string" && rawSeverity in ADVISOR_SEVERITIES
        ? (rawSeverity as OmpAdvisorSeverity)
        : undefined;
    const advisor = readOptionalString(Reflect.get(value, "advisor"));
    return [{ note, ...(severity ? { severity } : {}), ...(advisor ? { advisor } : {}) }];
  });
}

function formatAdvisorNote(note: OmpAdvisorNote): string {
  const prefix = [
    note.severity ? `[${note.severity}]` : null,
    note.advisor ? `[${note.advisor}]` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return prefix ? `${prefix} ${note.note}` : note.note;
}

function buildAdvisorLabel(noteCount: number, blockerCount: number): string {
  if (noteCount === 0) return "Advisor";
  const label = `Advisor · ${noteCount} ${noteCount === 1 ? "note" : "notes"}`;
  return blockerCount > 0
    ? `${label} · ${blockerCount} ${blockerCount === 1 ? "blocker" : "blockers"}`
    : label;
}

function buildAdvisorCallId(message: OmpCustomMessage, text: string): string {
  const id = readOptionalString(Reflect.get(message, "id"));
  if (id) return `omp-advisor:${id}`;
  const digest = createHash("sha1").update(text.trim()).digest("hex").slice(0, 12);
  return `omp-advisor:${digest}`;
}

export function mapOmpAdvisorMessageToToolCall(
  message: OmpCustomMessage,
  text: string,
): OmpAdvisorToolCallItem | null {
  if (Reflect.get(message, "customType") !== "advisor") return null;

  const notes = readAdvisorNotes(message);
  const blockerCount = notes.filter((note) => note.severity === "blocker").length;
  return {
    type: "tool_call",
    callId: buildAdvisorCallId(message, text),
    name: "advisor",
    status: "completed",
    detail: {
      type: "plain_text",
      label: buildAdvisorLabel(notes.length, blockerCount),
      text: notes.length > 0 ? notes.map(formatAdvisorNote).join("\n\n") : text,
      icon: "brain",
    },
    metadata: {
      synthetic: true,
      source: "omp_advisor",
      noteCount: notes.length,
      blockerCount,
    },
    error: null,
  };
}
