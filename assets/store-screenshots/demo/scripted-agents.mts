// Scripted Claude Code and Codex clients for staging store screenshots.
// Each agent replays a fixed conversation through the real daemon, so the app
// renders real timeline rows, permission prompts, and running states.
import { randomUUID } from "node:crypto";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
  ToolCallDetail,
} from "../../../packages/server/src/server/agent/agent-sdk-types.js";
import { getAgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";

export type ScriptStep =
  | { kind: "say"; text: string }
  | { kind: "think"; text: string }
  | { kind: "tool"; name: string; detail: ToolCallDetail }
  | { kind: "todo"; items: { text: string; completed: boolean }[] }
  | { kind: "wait"; ms: number }
  | { kind: "running-tool"; name: string; detail: ToolCallDetail }
  | { kind: "ask"; name: string; title: string; detail: ToolCallDetail };

export interface AgentScript {
  /** Matched against the start of the prompt that opens the turn. */
  prompt: string;
  steps: ScriptStep[];
  /** Leave the turn open after the last step. */
  keepRunning?: boolean;
  /** Pause between steps, so "Worked for" reflects a believable duration. */
  stepDelayMs?: number;
}

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

const MODELS: Record<string, AgentModelDefinition[]> = {
  claude: [
    {
      provider: "claude",
      id: "claude-opus-5-5",
      label: "Opus 5.5",
      isDefault: true,
      thinkingOptions: [
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ],
      defaultThinkingOptionId: "medium",
    },
    { provider: "claude", id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  ],
  codex: [
    {
      provider: "codex",
      id: "gpt-5.6-sol",
      label: "GPT-5.6-Sol",
      isDefault: true,
      thinkingOptions: [
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ],
      defaultThinkingOptionId: "medium",
    },
  ],
};

function promptText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") return prompt;
  return prompt
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
    .join("");
}

class ScriptedSession implements AgentSession {
  readonly capabilities = CAPABILITIES;
  readonly id = randomUUID();
  private readonly listeners = new Set<(event: AgentStreamEvent) => void>();
  private readonly history: AgentStreamEvent[] = [];
  private pending: AgentPermissionRequest[] = [];
  private activeTurnId: string | null = null;

  constructor(
    readonly provider: string,
    private readonly config: AgentSessionConfig,
    private readonly scripts: AgentScript[],
  ) {}

  private emit(event: AgentStreamEvent): void {
    const tagged = this.activeTurnId ? { ...event, turnId: this.activeTurnId } : event;
    this.history.push(tagged);
    for (const listener of this.listeners) listener(tagged);
  }

  private timeline(item: AgentTimelineItem): void {
    this.emit({ type: "timeline", provider: this.provider, item });
  }

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    const turnId = randomUUID();
    this.activeTurnId = turnId;
    const text = promptText(prompt);
    const script = this.scripts.find((candidate) => text.startsWith(candidate.prompt));
    setTimeout(() => void this.play(text, script), 50);
    return { turnId };
  }

  private async play(text: string, script: AgentScript | undefined): Promise<void> {
    this.emit({ type: "turn_started", provider: this.provider });
    this.timeline({ type: "user_message", text, messageId: randomUUID() });
    const delay = script?.stepDelayMs ?? 400;
    for (const step of script?.steps ?? [{ kind: "say", text: "Done." } as const]) {
      await new Promise((resolve) => setTimeout(resolve, step.kind === "wait" ? step.ms : delay));
      this.playStep(step);
      if (step.kind === "ask") return;
    }
    if (script?.keepRunning) return;
    this.emit({
      type: "turn_completed",
      provider: this.provider,
      usage: { inputTokens: 48_210, outputTokens: 3_904 },
    });
    this.activeTurnId = null;
  }

  private playStep(step: ScriptStep): void {
    switch (step.kind) {
      case "say":
        this.timeline({ type: "assistant_message", text: step.text, messageId: randomUUID() });
        return;
      case "think":
        this.timeline({ type: "reasoning", text: step.text });
        return;
      case "todo":
        this.timeline({ type: "todo", items: step.items });
        return;
      case "wait":
        return;
      case "tool":
      case "running-tool": {
        const callId = randomUUID();
        this.timeline({
          type: "tool_call",
          callId,
          name: step.name,
          status: "running",
          error: null,
          detail: step.detail,
        });
        if (step.kind === "tool") {
          this.timeline({
            type: "tool_call",
            callId,
            name: step.name,
            status: "completed",
            error: null,
            detail: step.detail,
          });
        }
        return;
      }
      case "ask": {
        const request: AgentPermissionRequest = {
          id: randomUUID(),
          provider: this.provider,
          name: step.name,
          kind: "tool",
          title: step.title,
          detail: step.detail,
        };
        this.pending = [request];
        this.emit({ type: "permission_requested", provider: this.provider, request });
      }
    }
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    yield* this.history;
  }

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.config.model ?? MODELS[this.provider]?.[0]?.id ?? null,
      thinkingOptionId: this.config.thinkingOptionId ?? "medium",
      modeId: this.config.modeId ?? null,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return getAgentProviderDefinition(this.provider).modes;
  }

  async getCurrentMode(): Promise<string | null> {
    return this.config.modeId ?? null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions(): AgentPermissionRequest[] {
    return this.pending;
  }

  async respondToPermission(requestId: string, resolution: AgentPermissionResponse) {
    this.pending = [];
    this.emit({ type: "permission_resolved", provider: this.provider, requestId, resolution });
  }

  describePersistence(): AgentPersistenceHandle {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {
    if (!this.activeTurnId) return;
    this.emit({ type: "turn_canceled", provider: this.provider, reason: "Interrupted" });
    this.activeTurnId = null;
  }

  async close(): Promise<void> {}
}

export class ScriptedAgentClient implements AgentClient {
  readonly capabilities = CAPABILITIES;

  constructor(
    readonly provider: string,
    private readonly scripts: AgentScript[],
  ) {}

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return new ScriptedSession(this.provider, config, this.scripts);
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    return new ScriptedSession(
      this.provider,
      { provider: this.provider, cwd: overrides?.cwd ?? process.cwd(), ...overrides },
      this.scripts,
    );
  }

  async fetchCatalog() {
    return {
      models: MODELS[this.provider] ?? [],
      modes: getAgentProviderDefinition(this.provider).modes,
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}
