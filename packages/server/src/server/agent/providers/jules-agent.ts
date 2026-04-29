import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentLaunchContext,
  AgentMode,
  AgentModelDefinition,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
  ListModelsOptions,
  ListModesOptions,
} from "../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../provider-launch-config.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";
import { formatDiagnosticStatus, formatProviderDiagnostic, toDiagnosticErrorMessage } from "./diagnostic-utils.js";
import { JulesCli, type JulesActivity, type JulesSessionSnapshot } from "./jules-cli.js";
import { JulesRepoError, resolveGitHubRepo } from "./jules-repo.js";

const JULES_PROVIDER = "jules";

const JULES_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
};

function promptToText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  return prompt.map((block) => (block.type === "text" ? block.text : "")).join("\n").trim();
}

function mapActivity(activity: JulesActivity): AgentTimelineItem {
  const payload = activity.payload as Record<string, unknown> | null;
  const text = typeof payload?.text === "string" ? payload.text : undefined;
  if (activity.type.includes("think")) {
    return { type: "reasoning", text: text ?? JSON.stringify(activity.payload) };
  }
  if (activity.type.includes("tool") || activity.type.includes("edit")) {
    return {
      type: "tool_call",
      callId: activity.id,
      name: typeof payload?.toolName === "string" ? payload.toolName : activity.type,
      detail: { type: "unknown", input: activity.payload, output: null },
      status: "completed",
      error: null,
    };
  }
  return { type: "assistant_message", text: text ?? JSON.stringify(activity.payload) };
}

interface JulesAgentClientOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
}

export class JulesAgentSession implements AgentSession {
  readonly provider = JULES_PROVIDER;
  readonly capabilities = JULES_CAPABILITIES;

  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly timeline: AgentTimelineItem[] = [];
  private readonly seenActivityIds = new Set<string>();
  private readonly repo: string;
  private readonly cli: JulesCli;
  private sessionId: string | null;
  private activeTurnId: string | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private intervalMs = 5_000;
  private idlePolls = 0;
  private lastActivityAt = 0;

  constructor(params: { cli: JulesCli; sessionId?: string; repo: string }) {
    this.repo = params.repo;
    this.cli = params.cli;
    this.sessionId = params.sessionId ?? null;
  }

  get id(): string | null {
    return this.sessionId;
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    if (this.sessionId) {
      callback({ type: "thread_started", provider: this.provider, sessionId: this.sessionId });
    }
    return () => this.subscribers.delete(callback);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    for (const item of this.timeline) {
      yield { type: "timeline", provider: this.provider, item };
    }
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return { provider: this.provider, sessionId: this.sessionId, modeId: null };
  }
  async getAvailableModes(): Promise<AgentMode[]> { return []; }
  async getCurrentMode(): Promise<string | null> { return null; }
  async setMode(_modeId: string): Promise<void> { throw new Error("Jules has no modes"); }
  getPendingPermissions() { return []; }
  async respondToPermission(): Promise<void> { throw new Error("Jules has no permissions"); }
  describePersistence(): AgentPersistenceHandle | null {
    if (!this.sessionId) return null;
    return {
      provider: this.provider,
      sessionId: this.sessionId,
      metadata: { sessionId: this.sessionId, repo: this.repo },
    };
  }
  async setModel(): Promise<void> {}
  async setThinkingOption(): Promise<void> {}

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    const { turnId } = await this.startTurn(prompt, options);
    await new Promise<void>((resolve, reject) => {
      const unsubscribe = this.subscribe((event) => {
        if (!("turnId" in event) || event.turnId !== turnId) return;
        if (event.type === "turn_completed") {
          unsubscribe();
          resolve();
        } else if (event.type === "turn_failed") {
          unsubscribe();
          reject(new Error(event.error));
        }
      });
    });
    const finalText =
      [...this.timeline].reverse().find((item) => item.type === "assistant_message" && item.text.trim())?.text ?? "";
    return { sessionId: this.sessionId ?? randomUUID(), finalText, timeline: [...this.timeline] };
  }

  async startTurn(prompt: AgentPromptInput, _options?: AgentRunOptions): Promise<{ turnId: string }> {
    const turnId = randomUUID();
    this.activeTurnId = turnId;
    if (!this.sessionId) {
      const initialPrompt = promptToText(prompt) || "Start";
      const created = await this.cli.remoteNew({ repo: this.repo, prompt: initialPrompt });
      this.sessionId = created.sessionId;
      this.emit({
        type: "thread_started",
        provider: this.provider,
        sessionId: this.sessionId,
      });
    }
    this.emit({ type: "turn_started", provider: this.provider, turnId });
    this.startPoller();
    return { turnId };
  }

  async interrupt(): Promise<void> {
    const turnId = this.activeTurnId ?? undefined;
    this.stopPoller();
    this.activeTurnId = null;
    this.emit({ type: "turn_canceled", provider: this.provider, reason: "detached", turnId });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopPoller();
    this.subscribers.clear();
  }

  private emit(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) callback(event);
  }
  private appendTimeline(item: AgentTimelineItem): void {
    this.timeline.push(item);
    this.emit({ type: "timeline", provider: this.provider, turnId: this.activeTurnId ?? undefined, item });
  }

  private startPoller(): void {
    this.stopPoller();
    this.scheduleTick(0);
  }
  private stopPoller(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }
  private scheduleTick(delayMs: number): void {
    if (this.closed || !this.sessionId) return;
    this.pollTimer = setTimeout(() => void this.pollOnce(), delayMs);
  }

  private async pollOnce(): Promise<void> {
    if (!this.sessionId || this.closed) return;
    try {
      const snapshot = await this.cli.remotePull(this.sessionId);
      this.applySnapshot(snapshot);
      if (snapshot.status === "COMPLETED" || snapshot.status === "FAILED") {
        this.stopPoller();
        if (snapshot.status === "COMPLETED" && snapshot.prUrl) {
          this.appendTimeline({
            type: "pr_ready",
            url: snapshot.prUrl,
            branch: snapshot.branch ?? "unknown",
            title: snapshot.prTitle,
          });
          this.emit({ type: "turn_completed", provider: this.provider, turnId: this.activeTurnId ?? undefined });
        } else {
          this.emit({
            type: "turn_failed",
            provider: this.provider,
            error: "Jules session failed",
            diagnostic: snapshot.status,
            turnId: this.activeTurnId ?? undefined,
          });
        }
        return;
      }
    } catch (error) {
      this.emit({
        type: "turn_failed",
        provider: this.provider,
        error: toDiagnosticErrorMessage(error),
        turnId: this.activeTurnId ?? undefined,
      });
      this.stopPoller();
      return;
    }
    this.scheduleTick(this.intervalMs);
  }

  private applySnapshot(snapshot: JulesSessionSnapshot): void {
    const newActivities = snapshot.activities.filter((item) => !this.seenActivityIds.has(item.id));
    for (const activity of newActivities) {
      this.seenActivityIds.add(activity.id);
      this.appendTimeline(mapActivity(activity));
    }
    if (newActivities.length > 0) {
      this.lastActivityAt = Date.now();
      this.intervalMs = 2_000;
      this.idlePolls = 0;
      return;
    }
    this.idlePolls += 1;
    if (Date.now() - this.lastActivityAt > 30_000) this.intervalMs = 5_000;
    if (this.idlePolls >= 3) this.intervalMs = 30_000;
  }
}

export class JulesAgentClient implements AgentClient {
  readonly provider = JULES_PROVIDER;
  readonly capabilities = JULES_CAPABILITIES;
  private readonly logger: Logger;
  private readonly workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  private readonly cli: JulesCli;
  private lastError: string | null = null;

  constructor(options: JulesAgentClientOptions) {
    this.logger = options.logger.child({ module: "agent", provider: JULES_PROVIDER });
    this.workspaceGitService = options.workspaceGitService;
    this.cli = new JulesCli({
      logger: this.logger,
      binaryPath: options.runtimeSettings?.command?.mode === "replace" ? options.runtimeSettings.command.argv[0] : undefined,
      env: options.runtimeSettings?.env ? ({ ...process.env, ...options.runtimeSettings.env } as NodeJS.ProcessEnv) : undefined,
    });
  }

  async createSession(config: AgentSessionConfig, _launchContext?: AgentLaunchContext): Promise<AgentSession> {
    if (!this.workspaceGitService) {
      throw new JulesRepoError("Workspace git service unavailable; cannot resolve GitHub repo for Jules");
    }
    const repo = await resolveGitHubRepo(config.cwd, this.workspaceGitService);
    return new JulesAgentSession({
      cli: this.cli,
      repo: `${repo.owner}/${repo.name}`,
    });
  }

  async resumeSession(handle: AgentPersistenceHandle): Promise<AgentSession> {
    const sessionId = (handle.metadata as { sessionId?: string } | undefined)?.sessionId ?? handle.sessionId;
    const snapshot = await this.cli.remotePull(sessionId);
    const session = new JulesAgentSession({
      cli: this.cli,
      sessionId,
      repo: snapshot.repo,
    });
    return session;
  }

  async listModels(_options: ListModelsOptions): Promise<AgentModelDefinition[]> { return []; }
  async listModes(_options: ListModesOptions): Promise<AgentMode[]> { return []; }

  async isAvailable(): Promise<boolean> {
    try {
      await this.cli.version();
      const auth = await this.cli.authStatus();
      if (!auth.loggedIn) {
        this.lastError = auth.diagnostic ?? "Not logged in. Run `jules login`.";
      }
      return auth.loggedIn;
    } catch (error) {
      this.lastError = toDiagnosticErrorMessage(error);
      return false;
    }
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    const available = await this.isAvailable();
    let version = "unknown";
    try {
      version = await this.cli.version();
    } catch {
      // ignored
    }
    return {
      diagnostic: formatProviderDiagnostic("Jules", [
        { label: "Version", value: version },
        { label: "Status", value: formatDiagnosticStatus(available) },
        { label: "Detail", value: this.lastError ?? "Ready" },
      ]),
    };
  }
}
