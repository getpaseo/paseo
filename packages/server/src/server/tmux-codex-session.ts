import { randomUUID } from "node:crypto";
import type {
  AgentCapabilityFlags,
  AgentFeature,
  AgentMode,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPermissionResult,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentStreamEvent,
  AgentTimelineItem,
} from "./agent/agent-sdk-types.js";

const TMUX_CODEX_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

const TMUX_CODEX_FEATURES: AgentFeature[] = [];
const TMUX_CODEX_MODES: AgentMode[] = [
  {
    id: "auto",
    label: "Bridge",
    description: "Bridged tmux Codex session",
  },
];

type SendKeysFn = (paneId: string, keys: string[]) => Promise<void>;
type CapturePaneFn = (paneId: string) => Promise<string>;
type IsProcessAliveFn = () => Promise<boolean>;

function normalizePrompt(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  return prompt
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function splitLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());
}

function computeAppendedText(previous: string, next: string): string | null {
  if (next === previous) {
    return null;
  }
  if (next.startsWith(previous)) {
    const appended = next.slice(previous.length).replace(/^\n+/, "");
    return appended.length > 0 ? appended : null;
  }

  const previousLines = splitLines(previous);
  const nextLines = splitLines(next);
  let sharedPrefix = 0;
  while (
    sharedPrefix < previousLines.length &&
    sharedPrefix < nextLines.length &&
    previousLines[sharedPrefix] === nextLines[sharedPrefix]
  ) {
    sharedPrefix += 1;
  }
  const appended = nextLines.slice(sharedPrefix).join("\n").trim();
  return appended.length > 0 ? appended : null;
}

export interface CreateTmuxCodexSessionOptions {
  sessionId: string;
  paneId: string;
  cwd: string;
  title: string;
  capturePane: CapturePaneFn;
  sendKeys: SendKeysFn;
  isProcessAlive: IsProcessAliveFn;
  pollIntervalMs?: number;
  settleDelayMs?: number;
  persistenceHandle?: AgentPersistenceHandle | null;
  externalSessionSource?: string;
  runtimeExtra?: Record<string, unknown>;
  loadTimeline?: () => Promise<AgentTimelineItem[]>;
}

export interface TmuxCodexSession extends AgentSession {
  pollNow(): Promise<void>;
}

export function createTmuxCodexSession(options: CreateTmuxCodexSessionOptions): TmuxCodexSession {
  const externalSessionSource = options.externalSessionSource ?? "tmux_codex";
  const runtimeExtra = options.runtimeExtra ?? {
    paneId: options.paneId,
    title: options.title,
  };
  let currentTurnId: string | null = null;
  let runtimeInfo: AgentRuntimeInfo = {
    provider: "codex",
    sessionId: options.sessionId,
    modeId: "auto",
    model: null,
    extra: {
      externalSessionSource,
      ...runtimeExtra,
    },
  };
  let pendingIdleTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let latestCaptured = "";
  let latestTimeline: AgentTimelineItem[] = [];
  let bootstrapStarted = false;
  const listeners = new Set<(event: AgentStreamEvent) => void>();
  const pollIntervalMs = options.pollIntervalMs ?? 1500;
  const settleDelayMs = options.settleDelayMs ?? 2500;

  const emit = (event: AgentStreamEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  const clearIdleTimer = () => {
    if (pendingIdleTimer) {
      clearTimeout(pendingIdleTimer);
      pendingIdleTimer = null;
    }
  };

  const markTurnCompletedLater = (turnId: string) => {
    clearIdleTimer();
    pendingIdleTimer = setTimeout(() => {
      pendingIdleTimer = null;
      if (closed || currentTurnId !== turnId) {
        return;
      }
      currentTurnId = null;
      emit({
        type: "turn_completed",
        provider: "codex",
        turnId,
      });
    }, settleDelayMs);
  };

  const loadTimelineSnapshot = async (): Promise<AgentTimelineItem[] | null> => {
    if (!options.loadTimeline) {
      return null;
    }
    try {
      const timeline = await options.loadTimeline();
      return timeline.length > 0 ? timeline : null;
    } catch {
      return null;
    }
  };

  const emitBootstrapEvents = async () => {
    if (bootstrapStarted) {
      return;
    }
    bootstrapStarted = true;
    const initialTimeline = await loadTimelineSnapshot();
    if (initialTimeline) {
      latestTimeline = initialTimeline;
      if (initialTimeline.length > 0) {
        emit({
          type: "thread_started",
          provider: "codex",
          sessionId: options.sessionId,
        });
        for (const item of initialTimeline) {
          emit({
            type: "timeline",
            provider: "codex",
            item,
          });
        }
      }
      return;
    }

    const initialCapture = await options.capturePane(options.paneId);
    if (!latestCaptured) {
      latestCaptured = (initialCapture ?? "").trimEnd();
    }

    if (latestCaptured.length > 0) {
      emit({
        type: "thread_started",
        provider: "codex",
        sessionId: options.sessionId,
      });
      emit({
        type: "timeline",
        provider: "codex",
        item: {
          type: "assistant_message",
          text: latestCaptured,
        },
      });
    }
  };

  const pollNow = async () => {
    if (closed) {
      return;
    }
    const [timelineSnapshot, capture, alive] = await Promise.all([
      loadTimelineSnapshot(),
      options.capturePane(options.paneId),
      options.isProcessAlive(),
    ]);
    const normalizedCapture = (capture ?? "").trimEnd();

    let emittedTimelineItem = false;
    if (timelineSnapshot) {
      const previousSerialized = latestTimeline.map((item) => JSON.stringify(item));
      const nextSerialized = timelineSnapshot.map((item) => JSON.stringify(item));
      let overlap = 0;
      const maxOverlap = Math.min(previousSerialized.length, nextSerialized.length);
      for (let candidate = maxOverlap; candidate > 0; candidate -= 1) {
        let matches = true;
        for (let index = 0; index < candidate; index += 1) {
          if (
            previousSerialized[previousSerialized.length - candidate + index] !==
            nextSerialized[index]
          ) {
            matches = false;
            break;
          }
        }
        if (matches) {
          overlap = candidate;
          break;
        }
      }
      const appendedItems = timelineSnapshot.slice(overlap);
      latestTimeline = timelineSnapshot;
      if (appendedItems.length > 0 && !currentTurnId) {
        currentTurnId = randomUUID();
        emit({
          type: "turn_started",
          provider: "codex",
          turnId: currentTurnId,
        });
      }
      for (const item of appendedItems) {
        emittedTimelineItem = true;
        emit({
          type: "timeline",
          provider: "codex",
          ...(currentTurnId ? { turnId: currentTurnId } : {}),
          item,
        });
      }
    } else {
      const appended = computeAppendedText(latestCaptured, normalizedCapture);
      latestCaptured = normalizedCapture;
      if (appended) {
        emittedTimelineItem = true;
        if (!currentTurnId) {
          currentTurnId = randomUUID();
          emit({
            type: "turn_started",
            provider: "codex",
            turnId: currentTurnId,
          });
        }
        emit({
          type: "timeline",
          provider: "codex",
          ...(currentTurnId ? { turnId: currentTurnId } : {}),
          item: {
            type: "assistant_message",
            text: appended,
          },
        });
      }
    }

    if (currentTurnId) {
      if (alive) {
        if (emittedTimelineItem) {
          markTurnCompletedLater(currentTurnId);
        }
      } else {
        const finishedTurnId = currentTurnId;
        currentTurnId = null;
        clearIdleTimer();
        emit({
          type: "turn_completed",
          provider: "codex",
          turnId: finishedTurnId,
        });
      }
    }
  };

  const pollHandle = setInterval(() => {
    void pollNow();
  }, pollIntervalMs);

  return {
    provider: "codex",
    id: options.sessionId,
    capabilities: TMUX_CODEX_CAPABILITIES,
    features: TMUX_CODEX_FEATURES,
    async run(prompt: AgentPromptInput, runOptions?: AgentRunOptions): Promise<AgentRunResult> {
      await this.startTurn(prompt, runOptions);
      return {
        sessionId: options.sessionId,
        finalText: "",
        timeline: [],
      };
    },
    async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
      if (currentTurnId) {
        throw new Error("tmux codex session already has an active turn");
      }
      const text = normalizePrompt(prompt).trim();
      if (!text) {
        throw new Error("prompt cannot be empty");
      }
      currentTurnId = randomUUID();
      await options.sendKeys(options.paneId, [text, "Enter"]);
      emit({
        type: "turn_started",
        provider: "codex",
        turnId: currentTurnId,
      });
      markTurnCompletedLater(currentTurnId);
      return { turnId: currentTurnId };
    },
    subscribe(callback: (event: AgentStreamEvent) => void): () => void {
      listeners.add(callback);
      if (listeners.size === 1) {
        void emitBootstrapEvents();
      }
      return () => {
        listeners.delete(callback);
      };
    },
    async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      const initialTimeline = await loadTimelineSnapshot();
      if (initialTimeline) {
        latestTimeline = initialTimeline;
        yield {
          type: "thread_started",
          provider: "codex",
          sessionId: options.sessionId,
        };
        for (const item of initialTimeline) {
          yield {
            type: "timeline",
            provider: "codex",
            item,
          };
        }
        return;
      }

      const initialCapture = await options.capturePane(options.paneId);
      const trimmed = (initialCapture ?? "").trimEnd();
      if (!latestCaptured) {
        latestCaptured = trimmed;
      }
      if (!trimmed) {
        return;
      }
      yield {
        type: "thread_started",
        provider: "codex",
        sessionId: options.sessionId,
      };
      yield {
        type: "timeline",
        provider: "codex",
        item: {
          type: "assistant_message",
          text: trimmed,
        },
      };
    },
    async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
      return runtimeInfo;
    },
    async getAvailableModes(): Promise<AgentMode[]> {
      return TMUX_CODEX_MODES;
    },
    async getCurrentMode(): Promise<string | null> {
      return "auto";
    },
    async setMode(): Promise<void> {
      return;
    },
    getPendingPermissions(): AgentPermissionRequest[] {
      return [];
    },
    async respondToPermission(
      _requestId: string,
      _response: AgentPermissionResponse,
    ): Promise<AgentPermissionResult | void> {
      return;
    },
    describePersistence(): AgentPersistenceHandle | null {
      return (
        options.persistenceHandle ?? {
          provider: "codex",
          sessionId: options.sessionId,
          metadata: {
            externalSessionSource,
            paneId: options.paneId,
            cwd: options.cwd,
            title: options.title,
          },
        }
      );
    },
    async interrupt(): Promise<void> {
      await options.sendKeys(options.paneId, ["C-c"]);
      if (currentTurnId) {
        const turnId = currentTurnId;
        currentTurnId = null;
        clearIdleTimer();
        emit({
          type: "turn_canceled",
          provider: "codex",
          reason: "interrupted",
          turnId,
        });
      }
    },
    async close(): Promise<void> {
      closed = true;
      clearIdleTimer();
      clearInterval(pollHandle);
    },
    async listCommands() {
      return [];
    },
    async setModel() {
      runtimeInfo = {
        ...runtimeInfo,
        model: null,
      };
    },
    async setThinkingOption() {
      return;
    },
    async setFeature() {
      return;
    },
    pollNow,
  };
}
