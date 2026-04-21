import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentFeature,
  AgentLaunchContext,
  AgentMode,
  AgentModelDefinition,
  AgentPersistenceHandle,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPermissionResult,
  AgentPromptInput,
  AgentProvider,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
  ListModesOptions,
  ListModelsOptions,
  ListPersistedAgentsOptions,
  PersistedAgentDescriptor,
  ToolCallTimelineItem,
} from "../agent-sdk-types.js";
import { getAgentProviderDefinition } from "../provider-manifest.js";

export const MOCK_LOAD_TEST_PROVIDER_ID = "mock";
export const MOCK_LOAD_TEST_DEFAULT_MODEL_ID = "five-minute-stream";
const MOCK_LOAD_TEST_MODE_ID = "load-test";
const MOCK_LOAD_TEST_DURATION_MS = 5 * 60 * 1000;
const MOCK_LOAD_TEST_INTERVAL_MS = 1000;

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

const MODELS: AgentModelDefinition[] = [
  {
    provider: MOCK_LOAD_TEST_PROVIDER_ID,
    id: MOCK_LOAD_TEST_DEFAULT_MODEL_ID,
    label: "Five minute stream",
    description: "Repeats synthetic markdown and tool-call timeline traffic for five minutes.",
    isDefault: true,
    metadata: {
      durationMs: MOCK_LOAD_TEST_DURATION_MS,
      intervalMs: MOCK_LOAD_TEST_INTERVAL_MS,
    },
  },
  {
    provider: MOCK_LOAD_TEST_PROVIDER_ID,
    id: "one-minute-stream",
    label: "One minute stream",
    description: "Shorter synthetic load stream for quick manual checks.",
    metadata: {
      durationMs: 60_000,
      intervalMs: 500,
    },
  },
  {
    provider: MOCK_LOAD_TEST_PROVIDER_ID,
    id: "ten-second-stream",
    label: "Ten second stream",
    description: "Fast synthetic load stream for tests and smoke checks.",
    metadata: {
      durationMs: 10_000,
      intervalMs: 250,
    },
  },
];

type ActiveTurn = {
  turnId: string;
  prompt: AgentPromptInput;
  startedAt: number;
  iteration: number;
  durationMs: number;
  intervalMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (result: AgentRunResult) => void;
  completed: Promise<AgentRunResult>;
};

function resolveModelProfile(modelId: string | null | undefined): {
  modelId: string;
  durationMs: number;
  intervalMs: number;
} {
  const model = MODELS.find((entry) => entry.id === modelId) ?? MODELS[0]!;
  const metadata = model.metadata ?? {};
  return {
    modelId: model.id,
    durationMs:
      typeof metadata.durationMs === "number" ? metadata.durationMs : MOCK_LOAD_TEST_DURATION_MS,
    intervalMs:
      typeof metadata.intervalMs === "number" ? metadata.intervalMs : MOCK_LOAD_TEST_INTERVAL_MS,
  };
}

function promptToText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  return prompt
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
}

function buildMarkdownDocument(iteration: number, prompt: AgentPromptInput): string {
  const promptPreview = promptToText(prompt).slice(0, 160) || "No prompt text supplied.";
  return [
    `## Synthetic Load Cycle ${iteration}`,
    "",
    `Prompt preview: ${promptPreview}`,
    "",
    "| Signal | Value |",
    "| --- | --- |",
    `| cycle | ${iteration} |`,
    "| stream | markdown + reasoning + tools |",
    "",
    "```ts",
    `const cycle = ${iteration};`,
    'const purpose = "exercise app parsing and terminal rendering under load";',
    "```",
    "",
    "This paragraph is intentionally stable so repeated cycles produce predictable UI pressure.",
    "",
  ].join("\n");
}

function splitText(text: string, chunks: number): string[] {
  const size = Math.ceil(text.length / chunks);
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    parts.push(text.slice(index, index + size));
  }
  return parts;
}

function createToolCall(input: {
  turnId: string;
  iteration: number;
  name: string;
  status: ToolCallTimelineItem["status"];
  detail: ToolCallTimelineItem["detail"];
}): ToolCallTimelineItem {
  return {
    type: "tool_call",
    callId: `${input.turnId}:${input.name}:${input.iteration}`,
    name: input.name,
    status: input.status,
    error: null,
    detail: input.detail,
  };
}

export class MockLoadTestAgentClient implements AgentClient {
  readonly provider: AgentProvider = MOCK_LOAD_TEST_PROVIDER_ID;
  readonly capabilities = CAPABILITIES;

  constructor(private readonly logger?: Logger) {}

  async createSession(
    config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    return new MockLoadTestAgentSession({
      config,
      sessionId: randomUUID(),
      logger: this.logger,
    });
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const metadata = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
    return new MockLoadTestAgentSession({
      config: {
        cwd: String(metadata.cwd ?? overrides?.cwd ?? process.cwd()),
        ...metadata,
        ...overrides,
        provider: MOCK_LOAD_TEST_PROVIDER_ID,
      },
      sessionId: handle.sessionId,
      logger: this.logger,
    });
  }

  async listModels(_options: ListModelsOptions): Promise<AgentModelDefinition[]> {
    return MODELS;
  }

  async listModes(_options: ListModesOptions): Promise<AgentMode[]> {
    return getAgentProviderDefinition(MOCK_LOAD_TEST_PROVIDER_ID).modes;
  }

  async listPersistedAgents(
    _options?: ListPersistedAgentsOptions,
  ): Promise<PersistedAgentDescriptor[]> {
    return [];
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    return {
      diagnostic: "Mock load-test provider is available in development builds.",
    };
  }
}

export class MockLoadTestAgentSession implements AgentSession {
  readonly provider: AgentProvider = MOCK_LOAD_TEST_PROVIDER_ID;
  readonly capabilities = CAPABILITIES;
  readonly features: AgentFeature[] = [];
  readonly id: string;
  private readonly listeners = new Set<(event: AgentStreamEvent) => void>();
  private readonly history: AgentStreamEvent[] = [];
  private readonly logger?: Logger;
  private activeTurn: ActiveTurn | null = null;
  private modeId: string | null;
  private modelId: string | null;

  constructor(options: {
    config: AgentSessionConfig;
    sessionId: string;
    logger?: Logger;
  }) {
    this.id = options.sessionId;
    this.logger = options.logger;
    this.modeId = options.config.modeId ?? MOCK_LOAD_TEST_MODE_ID;
    this.modelId = options.config.model ?? MOCK_LOAD_TEST_DEFAULT_MODEL_ID;
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    const { turnId } = await this.startTurn(prompt, options);
    const turn = this.activeTurn;
    if (!turn || turn.turnId !== turnId) {
      throw new Error("Mock load-test turn did not start");
    }
    return turn.completed;
  }

  async startTurn(
    prompt: AgentPromptInput,
    _options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    if (this.activeTurn) {
      throw new Error("Mock load-test provider already has an active turn");
    }

    const profile = resolveModelProfile(this.modelId);
    const turnId = randomUUID();
    let resolve!: (result: AgentRunResult) => void;
    const completed = new Promise<AgentRunResult>((promiseResolve) => {
      resolve = promiseResolve;
    });
    const turn: ActiveTurn = {
      turnId,
      prompt,
      startedAt: Date.now(),
      iteration: 0,
      durationMs: profile.durationMs,
      intervalMs: profile.intervalMs,
      timer: null,
      resolve,
      completed,
    };
    this.activeTurn = turn;

    this.schedule(turn, 0);
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    for (const event of this.history) {
      yield event;
    }
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.modelId,
      modeId: this.modeId,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return getAgentProviderDefinition(MOCK_LOAD_TEST_PROVIDER_ID).modes;
  }

  async getCurrentMode(): Promise<string | null> {
    return this.modeId;
  }

  async setMode(modeId: string): Promise<void> {
    this.modeId = modeId;
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }

  async respondToPermission(
    _requestId: string,
    _response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void> {
    return undefined;
  }

  describePersistence(): AgentPersistenceHandle | null {
    return {
      provider: this.provider,
      sessionId: this.id,
      metadata: {
        model: this.modelId,
        modeId: this.modeId,
      },
    };
  }

  async interrupt(): Promise<void> {
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    this.clearTurnTimer(turn);
    this.activeTurn = null;
    const event: AgentStreamEvent = {
      type: "turn_canceled",
      provider: this.provider,
      reason: "Interrupted",
      turnId: turn.turnId,
    };
    this.emit(event);
    turn.resolve({
      sessionId: this.id,
      finalText: "",
      timeline: [],
      canceled: true,
    });
  }

  async close(): Promise<void> {
    await this.interrupt();
    this.listeners.clear();
  }

  async setModel(modelId: string | null): Promise<void> {
    this.modelId = modelId ?? MOCK_LOAD_TEST_DEFAULT_MODEL_ID;
  }

  private schedule(turn: ActiveTurn, delayMs: number): void {
    turn.timer = setTimeout(() => {
      this.tick(turn);
    }, delayMs);
    turn.timer.unref?.();
  }

  private tick(turn: ActiveTurn): void {
    if (this.activeTurn !== turn) {
      return;
    }

    this.clearTurnTimer(turn);
    if (turn.iteration === 0) {
      this.emit({
        type: "turn_started",
        provider: this.provider,
        turnId: turn.turnId,
      });
    }

    const elapsedMs = Date.now() - turn.startedAt;
    if (elapsedMs >= turn.durationMs) {
      this.finishTurn(turn);
      return;
    }

    turn.iteration += 1;
    this.emitIteration(turn);
    this.schedule(turn, turn.intervalMs);
  }

  private emitIteration(turn: ActiveTurn): void {
    const { turnId, iteration, prompt } = turn;
    this.emitTimeline(turnId, {
      type: "reasoning",
      text: `Thinking chunk ${iteration}: simulate planning pressure before rendering markdown.\n`,
    });

    for (const chunk of splitText(buildMarkdownDocument(iteration, prompt), 4)) {
      this.emitTimeline(turnId, {
        type: "assistant_message",
        text: chunk,
      });
    }

    const editDetail = {
      type: "edit" as const,
      filePath: `src/load-test-${iteration}.ts`,
      oldString: "before",
      newString: "after",
      unifiedDiff: [
        `diff --git a/src/load-test-${iteration}.ts b/src/load-test-${iteration}.ts`,
        "@@",
        "-before",
        "+after",
      ].join("\n"),
    };
    this.emitTimeline(
      turnId,
      createToolCall({
        turnId,
        iteration,
        name: "edit",
        status: "running",
        detail: editDetail,
      }),
    );
    this.emitTimeline(
      turnId,
      createToolCall({
        turnId,
        iteration,
        name: "edit",
        status: "completed",
        detail: editDetail,
      }),
    );

    const shellDetail = {
      type: "shell" as const,
      command: `printf 'mock load cycle ${iteration}\\n'`,
      cwd: "/tmp/paseo-mock-load",
      output: `mock load cycle ${iteration}\n`,
      exitCode: 0,
    };
    this.emitTimeline(
      turnId,
      createToolCall({
        turnId,
        iteration,
        name: "bash",
        status: "running",
        detail: shellDetail,
      }),
    );
    this.emitTimeline(
      turnId,
      createToolCall({
        turnId,
        iteration,
        name: "bash",
        status: "completed",
        detail: shellDetail,
      }),
    );

    this.emit({
      type: "usage_updated",
      provider: this.provider,
      turnId,
      usage: {
        inputTokens: iteration * 32,
        outputTokens: iteration * 128,
        contextWindowUsedTokens: iteration * 160,
        contextWindowMaxTokens: 128_000,
      },
    });
  }

  private finishTurn(turn: ActiveTurn): void {
    this.activeTurn = null;
    this.emitTimeline(turn.turnId, {
      type: "assistant_message",
      text: "## Synthetic load test complete\n\nThe mock provider finished its foreground turn.\n",
    });
    const usage = {
      inputTokens: turn.iteration * 32,
      outputTokens: turn.iteration * 128,
      contextWindowUsedTokens: turn.iteration * 160,
      contextWindowMaxTokens: 128_000,
    };
    this.emit({
      type: "turn_completed",
      provider: this.provider,
      turnId: turn.turnId,
      usage,
    });
    turn.resolve({
      sessionId: this.id,
      finalText: "Synthetic load test complete",
      usage,
      timeline: [],
      canceled: false,
    });
  }

  private emitTimeline(turnId: string, item: AgentTimelineItem): void {
    this.emit({
      type: "timeline",
      provider: this.provider,
      turnId,
      item,
    });
  }

  private emit(event: AgentStreamEvent): void {
    this.history.push(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger?.warn({ err: error }, "Mock load-test listener failed");
      }
    }
  }

  private clearTurnTimer(turn: ActiveTurn): void {
    if (!turn.timer) {
      return;
    }
    clearTimeout(turn.timer);
    turn.timer = null;
  }
}
