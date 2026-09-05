import type { AgentStreamEvent } from "./agent-sdk-types.js";

const MIN_TITLE_WORDS = 4;
const MAX_TITLE_WORDS = 7;
const MAX_TITLE_CHARS = 60;
const MAX_HEADING_LINE_CHARS = MAX_TITLE_CHARS + 2;

interface PendingHeading {
  turnId: string;
  text: string;
  rejected: boolean;
}

export interface ResponseHeadingObservation {
  agentId: string;
  turnId: string | undefined;
  event: AgentStreamEvent;
}

function parseTitle(line: string): string | null {
  if (!line.startsWith("# ")) {
    return null;
  }

  const title = line.slice(2).trim();
  if (title.length === 0 || title.length > MAX_TITLE_CHARS) {
    return null;
  }

  const wordCount = title.split(/\s+/u).length;
  return wordCount >= MIN_TITLE_WORDS && wordCount <= MAX_TITLE_WORDS ? title : null;
}

function firstLineBoundary(text: string): number {
  const lf = text.indexOf("\n");
  const cr = text.indexOf("\r");
  if (lf === -1) return cr;
  if (cr === -1) return lf;
  return Math.min(lf, cr);
}

export class ResponseHeadingTitleTracker {
  private readonly pendingByAgent = new Map<string, PendingHeading>();

  observe(input: ResponseHeadingObservation): string | null {
    const { agentId, turnId, event } = input;
    if (!turnId) {
      return null;
    }

    if (
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled"
    ) {
      const pending = this.pendingByAgent.get(agentId);
      this.pendingByAgent.delete(agentId);
      if (!pending || pending.turnId !== turnId || pending.rejected || pending.text.length === 0) {
        return null;
      }
      return parseTitle(pending.text);
    }

    if (event.type !== "timeline" || event.item.type !== "assistant_message") {
      return null;
    }

    const pending = this.getPending(agentId, turnId);
    if (pending.rejected || event.item.text.length === 0) {
      return null;
    }

    pending.text += event.item.text;
    if (!"# ".startsWith(pending.text) && !pending.text.startsWith("# ")) {
      pending.rejected = true;
      pending.text = "";
      return null;
    }

    const boundary = firstLineBoundary(pending.text);
    if (boundary !== -1) {
      const title = parseTitle(pending.text.slice(0, boundary));
      pending.rejected = true;
      pending.text = "";
      return title;
    }

    if (pending.text.length > MAX_HEADING_LINE_CHARS) {
      pending.rejected = true;
      pending.text = "";
    }
    return null;
  }

  discard(agentId: string): void {
    this.pendingByAgent.delete(agentId);
  }

  private getPending(agentId: string, turnId: string): PendingHeading {
    const existing = this.pendingByAgent.get(agentId);
    if (existing?.turnId === turnId) {
      return existing;
    }

    const pending: PendingHeading = { turnId, text: "", rejected: false };
    this.pendingByAgent.set(agentId, pending);
    return pending;
  }
}
