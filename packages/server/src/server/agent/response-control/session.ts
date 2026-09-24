import {
  parseResponseFooter,
  type ResponseFooterMetadata,
} from "@getpaseo/protocol/response-control/footer";
import type { AgentStreamEvent } from "../agent-sdk-types.js";

export const RESPONSE_CONTROL_INSTRUCTIONS = `Paseo response metadata:
At the end of each final response that ends your turn, append exactly one standalone line outside Markdown fences:
<paseo-meta message="One short sentence describing this turn's outcome." title="Chat topic" icon="🎛️" prompt1="Recommended next prompt" prompt2="Another option" />
The message is required. Target at most 220 characters. Describe what happened, including questions or blockers; do not claim unfinished work is done.
Use a 1–3-word title describing the chat and one complementary emoji icon. Include title and icon on your first response, then only when they change; omitted values stay unchanged.
Recommend one to three next prompts as prompt1, prompt2, and prompt3. Each is one sentence written as the user would send it to you, describing the most useful next step; omit them when no follow-up makes sense.
Use double-quoted XML attributes. Escape ampersands as &amp;, quotes as &quot;, and angle brackets as &lt; and &gt;.
Put the footer after all user-facing content. Never include it in progress updates, reasoning, tool calls, or examples. Paseo hides this footer and uses it for naming and completion notifications.`;

export function supportsResponseControl(provider: string): boolean {
  return ["claude", "codex", "opencode", "pi"].includes(provider);
}

interface TurnResponse {
  turnId: string;
  messageId?: string;
  text: string | null;
}

/** Only live session events enter here; history never produces naming or notification effects. */
export class ResponseControlSessions {
  private readonly mutations = new Map<string, Promise<void>>();
  private readonly enabled = new Set<string>();
  private readonly responses = new Map<string, TurnResponse>();

  async mutate<T>(agentId: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(agentId) ?? Promise.resolve();
    const result = previous.then(mutation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.mutations.set(agentId, settled);
    void settled.then(() => {
      if (this.mutations.get(agentId) === settled) this.mutations.delete(agentId);
      return undefined;
    });
    return result;
  }

  open(agentId: string, enabled: boolean): void {
    this.responses.delete(agentId);
    if (enabled) this.enabled.add(agentId);
    else this.enabled.delete(agentId);
  }

  observe(agentId: string, event: AgentStreamEvent, turnId: string | undefined): void {
    if (!this.enabled.has(agentId) || !turnId) return;
    if (event.type === "turn_started") {
      this.responses.delete(agentId);
      return;
    }
    if (event.type === "turn_failed" || event.type === "turn_canceled") {
      if (this.responses.get(agentId)?.turnId === turnId) this.responses.delete(agentId);
      return;
    }
    if (event.type !== "timeline") return;
    if (event.item.type !== "assistant_message") {
      this.responses.delete(agentId);
      return;
    }
    const previous = this.responses.get(agentId);
    const sameMessage = previous?.turnId === turnId && previous.messageId === event.item.messageId;
    if (sameMessage && previous.text === null) return;
    const text = sameMessage ? previous.text + event.item.text : event.item.text;
    // Refuse unbounded accumulation. A discarded prefix must never turn a code example into metadata.
    if (text.length > 2_000_000) {
      this.responses.set(agentId, { turnId, text: null, messageId: event.item.messageId });
      return;
    }
    this.responses.set(agentId, { turnId, text, messageId: event.item.messageId });
  }

  complete(agentId: string, turnId: string): ResponseFooterMetadata | null {
    const response = this.responses.get(agentId);
    this.responses.delete(agentId);
    if (response?.turnId !== turnId || response.text === null) return null;
    return parseResponseFooter(response.text)?.metadata ?? null;
  }

  close(agentId: string): void {
    this.enabled.delete(agentId);
    this.responses.delete(agentId);
  }
}
