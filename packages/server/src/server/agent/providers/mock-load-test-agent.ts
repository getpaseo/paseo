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
  ToolCallDetail,
  ToolCallTimelineItem,
} from "../agent-sdk-types.js";
import { getAgentProviderDefinition } from "../provider-manifest.js";

export const MOCK_LOAD_TEST_PROVIDER_ID = "mock";
export const MOCK_LOAD_TEST_DEFAULT_MODEL_ID = "five-minute-stream";
const MOCK_LOAD_TEST_MODE_ID = "load-test";
const MOCK_LOAD_TEST_DURATION_MS = 5 * 60 * 1000;
const MOCK_LOAD_TEST_INTERVAL_MS = 40;

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
    description:
      "Realistic agent flow streamed as sub-word tokens for five minutes (good for scroll/coalesce debugging).",
    isDefault: true,
    metadata: {
      durationMs: MOCK_LOAD_TEST_DURATION_MS,
      intervalMs: MOCK_LOAD_TEST_INTERVAL_MS,
    },
  },
  {
    provider: MOCK_LOAD_TEST_PROVIDER_ID,
    id: "thirty-minute-stream",
    label: "Thirty minute stream",
    description: "Long-running realistic stream for extended scroll-anchor debugging.",
    metadata: {
      durationMs: 30 * 60 * 1000,
      intervalMs: 50,
    },
  },
  {
    provider: MOCK_LOAD_TEST_PROVIDER_ID,
    id: "one-minute-stream",
    label: "One minute stream",
    description: "Shorter realistic stream for quick manual checks.",
    metadata: {
      durationMs: 60_000,
      intervalMs: 40,
    },
  },
  {
    provider: MOCK_LOAD_TEST_PROVIDER_ID,
    id: "ten-second-stream",
    label: "Ten second stream",
    description: "Fast realistic stream for tests and smoke checks.",
    metadata: {
      durationMs: 10_000,
      intervalMs: 5,
    },
  },
];

interface ActiveTurn {
  turnId: string;
  prompt: AgentPromptInput;
  startedAt: number;
  cycle: number;
  durationMs: number;
  intervalMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (result: AgentRunResult) => void;
  completed: Promise<AgentRunResult>;
  queue: CycleEvent[];
  emittedTokens: number;
  turnStarted: boolean;
}

type CycleEvent =
  | { kind: "assistant_token"; text: string }
  | { kind: "reasoning_token"; text: string }
  | { kind: "tool_running"; callId: string; name: string; detail: ToolCallDetail }
  | { kind: "tool_completed"; callId: string; name: string; detail: ToolCallDetail }
  | { kind: "usage" };

interface LargeAgentStreamPayloadRequest {
  bytes: number;
  kind: "diff" | "file" | "image";
}

interface AgentStreamStressRequest {
  count: number;
  coalesced: boolean;
}

function shouldEmitPlanApprovalPrompt(prompt: AgentPromptInput): boolean {
  return /emit\s+(?:a\s+)?synthetic\s+plan\s+approval/i.test(promptToText(prompt));
}

function resolveModelProfile(modelId: string | null | undefined): {
  modelId: string;
  durationMs: number;
  intervalMs: number;
} {
  const model = MODELS.find((entry) => entry.id === modelId) ?? MODELS[0];
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

function parseLargeAgentStreamPayloadPrompt(
  prompt: AgentPromptInput,
): LargeAgentStreamPayloadRequest | null {
  const text = promptToText(prompt);
  const match =
    /emit\s+(\d+)\s+(?:byte\s+)?(?:large\s+)?(diff|file|image)\s+agent stream (?:update|payload)/i.exec(
      text,
    );
  if (!match) {
    return null;
  }
  const bytes = Number(match[1]);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return null;
  }
  return {
    bytes: Math.min(bytes, 1_000_000),
    kind: match[2]?.toLowerCase() as LargeAgentStreamPayloadRequest["kind"],
  };
}

function parseAgentStreamStressPrompt(prompt: AgentPromptInput): AgentStreamStressRequest | null {
  const text = promptToText(prompt);
  const match = /emit\s+(\d+)\s+(coalesced\s+)?agent stream updates/i.exec(text);
  if (!match) {
    return null;
  }
  const count = Number(match[1]);
  if (!Number.isFinite(count) || count <= 0) {
    return null;
  }
  return {
    count: Math.min(count, 5_000),
    coalesced: Boolean(match[2]),
  };
}

function buildRepeatedPayload(bytes: number, prefix: string): string {
  const line = `${prefix} ${"x".repeat(96)}\n`;
  let output = "";
  while (output.length < bytes) {
    output += line;
  }
  return output.slice(0, bytes);
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const regex = /(\s*)(\S+)|(\s+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const [, leadingWs, word, lonelyWs] = match;
    if (lonelyWs !== undefined) {
      tokens.push(lonelyWs);
      continue;
    }
    const ws = leadingWs ?? "";
    const w = word ?? "";
    if (w.length <= 5) {
      tokens.push(ws + w);
      continue;
    }
    tokens.push(ws + w.slice(0, 4));
    for (let i = 4; i < w.length; i += 4) {
      tokens.push(w.slice(i, i + 4));
    }
  }
  return tokens;
}

function buildIntroParagraph(cycle: number): string {
  return [
    `## Cycle ${cycle}`,
    "",
    "I'll take a look at the scroll anchor behavior you described. Let me start by walking through how the conversation list currently handles streaming updates and where the auto-scroll logic actually lives. My instinct is that the anchor is supposed to pin to the bottom only when the user is already there, but I want to confirm that against the code rather than guess. This kind of behavior is usually a thin layout effect over a ref, and the bugs tend to come from event ordering rather than the math itself, so the first useful step is to read the relevant files.",
  ].join("\n");
}

function buildReasoningText(): string {
  return "Need to find the scroll container, the layout effect that watches for new messages, and any gesture handler that might fight with programmatic scrolling. Probably a ref on the FlatList plus a near-bottom threshold.";
}

function buildMidParagraph(): string {
  return [
    "Now I have a clearer picture. The auto-scroll uses a ref on the FlatList and tracks whether the user has scrolled away from the bottom by comparing the offset against the content size. There are a few subtle issues worth flagging before we change anything:",
    "",
    "- The threshold for 'near the bottom' is hardcoded at 80px, which feels too tight on dense content where headers and tool calls take up a lot of vertical space.",
    "- We rely on `onContentSizeChange` to detect new content, but that fires after layout, not as the streaming delta arrives, so we end up scrolling one frame late on fast streams.",
    "- The gesture handler does not pause scroll-to-bottom while the user is actively dragging, which means a drag in progress can be visually overridden mid-frame.",
    "- Coalescing happens upstream, so the FlatList sees fewer updates than the wire — but each batch can still cause a relayout.",
    "",
    "Let me make a small adjustment to the threshold and add a flag for active gestures, then run a quick command to confirm the order of events when streaming is fast.",
  ].join("\n");
}

function buildClosingParagraph(): string {
  return "The change should keep scroll-to-bottom working when the user is at the bottom while not yanking the viewport when they are reading earlier messages. The bash output confirms the `userIsAtBottom` flag flips correctly during a simulated streaming burst, and the gesture flag suppresses scroll while a drag is active. If you want, I can follow up with a regression test that drives the FlatList with synthetic deltas at high frequency to lock in the behavior. For now, I'll stop here so you can take a look.";
}

function buildEditDiff(filePath: string): string {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    "@@ -42,7 +42,9 @@",
    "   const ref = useRef<FlatList>(null);",
    "   const [userIsAtBottom, setUserIsAtBottom] = useState(true);",
    "-  const NEAR_BOTTOM_PX = 80;",
    "+  const NEAR_BOTTOM_PX = 160;",
    "+  const isDraggingRef = useRef(false);",
    "",
    "-  if (userIsAtBottom) ref.current?.scrollToEnd({ animated: true });",
    "+  if (userIsAtBottom && !isDraggingRef.current) {",
    "+    ref.current?.scrollToEnd({ animated: true });",
    "+  }",
  ].join("\n");
}

function buildCycleQueue(turnId: string, cycle: number): CycleEvent[] {
  const queue: CycleEvent[] = [];

  for (const tok of tokenize(buildIntroParagraph(cycle))) {
    queue.push({ kind: "assistant_token", text: tok });
  }

  for (const tok of tokenize(buildReasoningText())) {
    queue.push({ kind: "reasoning_token", text: tok });
  }

  const readDetail: ToolCallDetail = {
    type: "read",
    filePath: "packages/app/src/components/conversation-list.tsx",
  };
  const readId = `${turnId}:read:${cycle}`;
  queue.push({ kind: "tool_running", callId: readId, name: "read", detail: readDetail });
  queue.push({
    kind: "tool_completed",
    callId: readId,
    name: "read",
    detail: {
      ...readDetail,
      content:
        "export function ConversationList() {\n  const ref = useRef<FlatList>(null);\n  // ...\n}",
    },
  });

  const grepDetail: ToolCallDetail = {
    type: "search",
    query: "scrollToEnd",
    toolName: "grep",
    mode: "files_with_matches",
  };
  const grepId = `${turnId}:grep:${cycle}`;
  queue.push({ kind: "tool_running", callId: grepId, name: "grep", detail: grepDetail });
  queue.push({
    kind: "tool_completed",
    callId: grepId,
    name: "grep",
    detail: {
      ...grepDetail,
      filePaths: [
        "packages/app/src/components/conversation-list.tsx",
        "packages/app/src/hooks/use-scroll-anchor.ts",
      ],
      numFiles: 2,
      numMatches: 5,
    },
  });

  for (const tok of tokenize(buildMidParagraph())) {
    queue.push({ kind: "assistant_token", text: tok });
  }

  const editFile = "packages/app/src/hooks/use-scroll-anchor.ts";
  const editDetail: ToolCallDetail = {
    type: "edit",
    filePath: editFile,
    oldString: "const NEAR_BOTTOM_PX = 80;",
    newString: "const NEAR_BOTTOM_PX = 160;",
    unifiedDiff: buildEditDiff(editFile),
  };
  const editId = `${turnId}:edit:${cycle}`;
  queue.push({ kind: "tool_running", callId: editId, name: "edit", detail: editDetail });
  queue.push({ kind: "tool_completed", callId: editId, name: "edit", detail: editDetail });

  const shellDetail: ToolCallDetail = {
    type: "shell",
    command: "node scripts/simulate-stream-burst.mjs",
    cwd: "/tmp/paseo-mock-load",
    output:
      "[burst] tick 1 userIsAtBottom=true\n[burst] tick 2 userIsAtBottom=true\n[burst] drag-start isDragging=true\n[burst] tick 3 suppressed\n[burst] drag-end isDragging=false\n",
    exitCode: 0,
  };
  const shellId = `${turnId}:bash:${cycle}`;
  queue.push({ kind: "tool_running", callId: shellId, name: "bash", detail: shellDetail });
  queue.push({ kind: "tool_completed", callId: shellId, name: "bash", detail: shellDetail });

  for (const tok of tokenize(buildClosingParagraph())) {
    queue.push({ kind: "assistant_token", text: tok });
  }

  queue.push({ kind: "usage" });

  return queue;
}

function createToolCall(input: {
  callId: string;
  name: string;
  status: ToolCallTimelineItem["status"];
  detail: ToolCallDetail;
}): ToolCallTimelineItem {
  return {
    type: "tool_call",
    callId: input.callId,
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
        cwd: metadata.cwd ?? overrides?.cwd ?? process.cwd(),
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
  private pendingPermissions = new Map<string, AgentPermissionRequest>();
  private modeId: string | null;
  private modelId: string | null;

  constructor(options: { config: AgentSessionConfig; sessionId: string; logger?: Logger }) {
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
      cycle: 0,
      durationMs: profile.durationMs,
      intervalMs: profile.intervalMs,
      timer: null,
      resolve,
      completed,
      queue: [],
      emittedTokens: 0,
      turnStarted: false,
    };
    this.activeTurn = turn;

    const largePayload = parseLargeAgentStreamPayloadPrompt(prompt);
    const stress = parseAgentStreamStressPrompt(prompt);
    if (shouldEmitPlanApprovalPrompt(prompt)) {
      this.schedulePlanApprovalTurn(turn);
    } else if (largePayload) {
      this.scheduleLargePayloadTurn(turn, largePayload);
    } else if (stress) {
      this.scheduleStressTurn(turn, stress);
    } else {
      this.schedule(turn, 0);
    }
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
    return Array.from(this.pendingPermissions.values());
  }

  async respondToPermission(
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void> {
    if (!this.pendingPermissions.delete(requestId)) {
      return undefined;
    }

    const turn = this.activeTurn;
    this.emit({
      type: "permission_resolved",
      provider: this.provider,
      requestId,
      resolution: response,
      ...(turn ? { turnId: turn.turnId } : {}),
    });

    if (turn) {
      this.finishTurnWithText(turn, "Synthetic plan approval resolved");
    }
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

  private scheduleLargePayloadTurn(
    turn: ActiveTurn,
    largePayload: LargeAgentStreamPayloadRequest,
  ): void {
    turn.timer = setTimeout(() => {
      this.emitLargePayloadTurn(turn, largePayload);
    }, 0);
    turn.timer.unref?.();
  }

  private scheduleStressTurn(turn: ActiveTurn, stress: AgentStreamStressRequest): void {
    turn.timer = setTimeout(() => {
      this.emitStressTurn(turn, stress);
    }, 0);
    turn.timer.unref?.();
  }

  private schedulePlanApprovalTurn(turn: ActiveTurn): void {
    turn.timer = setTimeout(() => {
      this.emitPlanApprovalTurn(turn);
    }, 0);
    turn.timer.unref?.();
  }

  private emitPlanApprovalTurn(turn: ActiveTurn): void {
    if (this.activeTurn !== turn) {
      return;
    }

    this.clearTurnTimer(turn);
    this.emit({
      type: "turn_started",
      provider: this.provider,
      turnId: turn.turnId,
    });

    const request: AgentPermissionRequest = {
      id: `mock-plan-${turn.turnId}`,
      provider: this.provider,
      name: "MockPlanApproval",
      kind: "plan",
      title: "Plan",
      description: "Review the proposed plan before implementation starts.",
      input: {
        plan: "1. Add the README note.\n2. Keep the change scoped.\n3. Verify the diff.",
      },
      actions: [
        {
          id: "implement",
          label: "Implement",
          behavior: "allow",
          variant: "primary",
          intent: "implement",
        },
        {
          id: "dismiss",
          label: "Dismiss",
          behavior: "deny",
          variant: "secondary",
          intent: "dismiss",
        },
      ],
      metadata: {
        source: "mock_plan_approval",
      },
    };

    this.pendingPermissions.set(request.id, request);
    this.emit({
      type: "permission_requested",
      provider: this.provider,
      request,
      turnId: turn.turnId,
    });
  }

  private emitStressTurn(turn: ActiveTurn, stress: AgentStreamStressRequest): void {
    if (this.activeTurn !== turn) {
      return;
    }

    this.clearTurnTimer(turn);
    this.emit({
      type: "turn_started",
      provider: this.provider,
      turnId: turn.turnId,
    });

    for (let index = 0; index < stress.count; index += 1) {
      this.emitTimeline(
        turn.turnId,
        stress.coalesced
          ? {
              type: "assistant_message",
              text: `stress-update-${index}`,
            }
          : {
              type: "todo",
              items: [{ text: `stress-update-${index}`, completed: index % 2 === 0 }],
            },
      );
    }

    this.activeTurn = null;
    const usage = {
      inputTokens: 1,
      outputTokens: stress.count,
      contextWindowUsedTokens: stress.count,
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
      finalText: "Synthetic agent stream stress complete",
      usage,
      timeline: [],
      canceled: false,
    });
  }

  private emitLargePayloadTurn(
    turn: ActiveTurn,
    largePayload: LargeAgentStreamPayloadRequest,
  ): void {
    if (this.activeTurn !== turn) {
      return;
    }

    this.clearTurnTimer(turn);
    this.emit({
      type: "turn_started",
      provider: this.provider,
      turnId: turn.turnId,
    });

    const payload = buildRepeatedPayload(largePayload.bytes, largePayload.kind);
    if (largePayload.kind === "diff") {
      this.emitTimeline(
        turn.turnId,
        createToolCall({
          callId: `${turn.turnId}:edit:large`,
          name: "edit",
          status: "completed",
          detail: {
            type: "edit",
            filePath: "src/large-diff.ts",
            unifiedDiff: `diff --git a/src/large-diff.ts b/src/large-diff.ts\n${payload}`,
          },
        }),
      );
    } else if (largePayload.kind === "file") {
      this.emitTimeline(
        turn.turnId,
        createToolCall({
          callId: `${turn.turnId}:read:large`,
          name: "read",
          status: "completed",
          detail: {
            type: "read",
            filePath: "src/large-file.txt",
            content: payload,
          },
        }),
      );
    } else {
      this.emitTimeline(turn.turnId, {
        type: "assistant_message",
        text: `data:image/png;base64,${payload}`,
      });
    }

    this.activeTurn = null;
    const usage = {
      inputTokens: 1,
      outputTokens: largePayload.bytes,
      contextWindowUsedTokens: largePayload.bytes,
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
      finalText: "Synthetic large payload complete",
      usage,
      timeline: [],
      canceled: false,
    });
  }

  private tick(turn: ActiveTurn): void {
    if (this.activeTurn !== turn) {
      return;
    }

    this.clearTurnTimer(turn);
    if (!turn.turnStarted) {
      turn.turnStarted = true;
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

    if (turn.queue.length === 0) {
      turn.cycle += 1;
      turn.queue = buildCycleQueue(turn.turnId, turn.cycle);
    }

    const event = turn.queue.shift();
    if (event) {
      this.dispatchCycleEvent(turn, event);
    }

    this.schedule(turn, turn.intervalMs);
  }

  private dispatchCycleEvent(turn: ActiveTurn, event: CycleEvent): void {
    switch (event.kind) {
      case "assistant_token": {
        turn.emittedTokens += 1;
        this.emitTimeline(turn.turnId, {
          type: "assistant_message",
          text: event.text,
        });
        return;
      }
      case "reasoning_token": {
        turn.emittedTokens += 1;
        this.emitTimeline(turn.turnId, {
          type: "reasoning",
          text: event.text,
        });
        return;
      }
      case "tool_running":
      case "tool_completed": {
        this.emitTimeline(
          turn.turnId,
          createToolCall({
            callId: event.callId,
            name: event.name,
            status: event.kind === "tool_running" ? "running" : "completed",
            detail: event.detail,
          }),
        );
        return;
      }
      case "usage": {
        this.emit({
          type: "usage_updated",
          provider: this.provider,
          turnId: turn.turnId,
          usage: {
            inputTokens: turn.cycle * 32,
            outputTokens: turn.emittedTokens,
            contextWindowUsedTokens: turn.emittedTokens * 2,
            contextWindowMaxTokens: 128_000,
          },
        });
        return;
      }
    }
  }

  private finishTurn(turn: ActiveTurn): void {
    this.emitTimeline(turn.turnId, {
      type: "assistant_message",
      text: "\n\n_(end of synthetic stream)_\n",
    });
    this.finishTurnWithText(turn, "Synthetic load test complete");
  }

  private finishTurnWithText(turn: ActiveTurn, finalText: string): void {
    this.activeTurn = null;
    const usage = {
      inputTokens: turn.cycle * 32,
      outputTokens: turn.emittedTokens,
      contextWindowUsedTokens: turn.emittedTokens * 2,
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
      finalText,
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
