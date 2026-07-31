/**
 * Provider-side realtime voice events. This is a private daemon channel, not the
 * durable timeline: realtime call state is ephemeral and must never be persisted
 * or replayed as `AgentStreamEvent`s.
 */
export type AgentRealtimeVoiceEvent =
  | { kind: "started"; realtimeSessionId: string | null; version: string | null }
  | { kind: "sdp"; sdp: string }
  | { kind: "transcript"; role: "user" | "assistant"; text: string }
  | { kind: "error"; message: string }
  | { kind: "closed"; reason: string | null }
  /**
   * The provider transport died (child exit/error/dispose). Synthesized by the
   * provider session so a waiting call always gets a terminal event.
   */
  | { kind: "transport_closed"; reason: string };

/** A conversation item seeded at session start. Roles are the provider's allowed set. */
export interface AgentRealtimeVoiceInitialItem {
  role: "user" | "developer" | "assistant";
  text: string;
}

export interface AgentRealtimeVoiceStartParams {
  /** Client WebRTC offer SDP, relayed verbatim. */
  sdp: string;
  voice?: string;
  /** Caller-assigned id; the provider echoes it back on `started`. */
  realtimeSessionId: string;
  /**
   * Replaces the voice model's entire system prompt. When set, the caller owns
   * every instruction the model gets, including how to speak.
   */
  prompt?: string;
  /** Conversation seed. Subject to provider item/token limits. */
  initialItems?: AgentRealtimeVoiceInitialItem[];
  /**
   * Suppress the provider's own synthesized startup context. Set this when the
   * caller supplies its own, so the two don't compete.
   */
  includeStartupContext?: boolean;
}

/** A conversation item appended to a call that is already running. */
export interface AgentRealtimeVoiceAppendTextParams {
  text: string;
  /** Defaults to the provider's own default (`user`) when omitted. */
  role?: "user" | "developer" | "assistant";
}

/**
 * The subset of a provider session needed to run a realtime voice call. Only
 * providers whose session implements all of it can host Live Voice.
 */
export interface AgentRealtimeVoiceSession {
  realtimeStart(params: AgentRealtimeVoiceStartParams): Promise<void>;
  realtimeStop(): Promise<void>;
  /**
   * Puts text into the running conversation from outside it. This is how the
   * daemon tells the voice model about something that happened while the user
   * was not speaking.
   */
  realtimeAppendText(params: AgentRealtimeVoiceAppendTextParams): Promise<void>;
  subscribeRealtimeEvents(callback: (event: AgentRealtimeVoiceEvent) => void): () => void;
}

export function asAgentRealtimeVoiceSession(session: unknown): AgentRealtimeVoiceSession | null {
  if (!session || typeof session !== "object") return null;
  const candidate = session as unknown as Partial<AgentRealtimeVoiceSession>;
  if (
    typeof candidate.realtimeStart !== "function" ||
    typeof candidate.realtimeStop !== "function" ||
    typeof candidate.realtimeAppendText !== "function" ||
    typeof candidate.subscribeRealtimeEvents !== "function"
  ) {
    return null;
  }
  return candidate as AgentRealtimeVoiceSession;
}
