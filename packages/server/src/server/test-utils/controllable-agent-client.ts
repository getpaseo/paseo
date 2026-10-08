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
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  FetchCatalogOptions,
  SteerActiveTurnOptions,
  SteerResult,
} from "../agent/agent-sdk-types.js";

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};
const MODES: AgentMode[] = [{ id: "default", label: "Default", description: "Ask" }];

export interface ProviderCall {
  kind: "startTurn" | "steer" | "interrupt" | "respondToPermission";
  text?: string;
  requestId?: string;
}

interface Gate {
  promise: Promise<void>;
  release: () => void;
}

function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** A provider whose every side effect is recorded and whose acknowledgements can be held. */
export class ControllableAgentClient implements AgentClient {
  readonly capabilities = CAPABILITIES;
  readonly calls: ProviderCall[] = [];
  readonly sessions: ControllableSession[] = [];
  heldStarts = 0;
  heldSteers = 0;
  private startHold: Gate | null = null;
  private steerHold: Gate | null = null;

  constructor(readonly provider: string = "codex") {}

  holdStartTurn(): () => void {
    this.startHold = gate();
    const held = this.startHold;
    return () => held.release();
  }

  holdSteer(): () => void {
    this.steerHold = gate();
    const held = this.steerHold;
    return () => held.release();
  }

  get session(): ControllableSession {
    const last = this.sessions.at(-1);
    if (!last) throw new Error("no session created");
    return last;
  }

  callsOf(kind: ProviderCall["kind"]): ProviderCall[] {
    return this.calls.filter((call) => call.kind === kind);
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return this.open(config, randomUUID());
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    const config = { provider: this.provider, cwd: process.cwd(), ...overrides };
    return this.open(config as AgentSessionConfig, handle.sessionId);
  }

  async fetchCatalog(
    _options: FetchCatalogOptions,
  ): Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }> {
    const model = { provider: this.provider, id: "ctl", label: "Controllable", isDefault: true };
    return { models: [model], modes: MODES };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  takeStartHold(): Gate | null {
    const held = this.startHold;
    this.startHold = null;
    return held;
  }

  takeSteerHold(): Gate | null {
    const held = this.steerHold;
    this.steerHold = null;
    return held;
  }

  private open(config: AgentSessionConfig, sessionId: string): ControllableSession {
    const session = new ControllableSession(this, config, sessionId);
    this.sessions.push(session);
    return session;
  }
}

export class ControllableSession implements AgentSession {
  readonly capabilities = CAPABILITIES;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private pending: AgentPermissionRequest[] = [];
  private turn = 0;
  private activeTurnId: string | null = null;

  constructor(
    private readonly client: ControllableAgentClient,
    private readonly config: AgentSessionConfig,
    readonly id: string,
  ) {}

  get provider(): string {
    return this.client.provider;
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    const held = this.client.takeStartHold();
    if (held) {
      this.client.heldStarts += 1;
      await held.promise;
    }
    this.client.calls.push({ kind: "startTurn", text: String(prompt) });
    this.activeTurnId = `ctl-turn-${this.turn++}`;
    return { turnId: this.activeTurnId };
  }

  async steerActiveTurn(
    prompt: AgentPromptInput,
    _options: SteerActiveTurnOptions,
  ): Promise<SteerResult> {
    const held = this.client.takeSteerHold();
    if (held) {
      this.client.heldSteers += 1;
      await held.promise;
    }
    this.client.calls.push({ kind: "steer", text: String(prompt) });
    return { status: "accepted" };
  }

  async run(prompt: AgentPromptInput) {
    await this.startTurn(prompt);
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  /** Test control: the provider raises a permission or question of its own accord. */
  raise(request: Partial<AgentPermissionRequest> & { id: string }): void {
    const full = {
      provider: this.provider,
      name: "ask",
      kind: "question",
      ...request,
    } as AgentPermissionRequest;
    this.pending.push(full);
    this.emit({ type: "permission_requested", provider: this.provider, request: full });
  }

  completeTurn(): void {
    const turnId = this.activeTurnId ?? undefined;
    this.activeTurnId = null;
    this.emit({ type: "turn_completed", provider: this.provider, turnId });
  }

  private emit(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) callback(event);
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: "default" };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return MODES;
  }

  async getCurrentMode(): Promise<string | null> {
    return "default";
  }

  async setMode(_modeId: string): Promise<void> {}

  getPendingPermissions(): AgentPermissionRequest[] {
    return [...this.pending];
  }

  async respondToPermission(requestId: string, _response: AgentPermissionResponse): Promise<void> {
    this.client.calls.push({ kind: "respondToPermission", requestId });
    this.pending = this.pending.filter((request) => request.id !== requestId);
    this.emit({
      type: "permission_resolved",
      provider: this.provider,
      requestId,
      resolution: { behavior: "deny" },
    });
  }

  describePersistence(): AgentPersistenceHandle | null {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {
    this.client.calls.push({ kind: "interrupt" });
    this.activeTurnId = null;
  }

  async close(): Promise<void> {}

  get cwd(): string {
    return this.config.cwd;
  }
}
