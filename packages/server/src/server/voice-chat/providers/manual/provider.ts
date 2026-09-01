import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type { Logger } from "pino";
import type {
  SessionOutboundMessage,
  VoiceAppContext,
  VoiceCallEvent,
} from "@getpaseo/protocol/messages";
import type { AgentManager } from "../../../agent/agent-manager.js";
import type { AgentStorage } from "../../../agent/agent-storage.js";
import type { AgentSessionConfig } from "../../../agent/agent-sdk-types.js";
import { sendPromptToAgent } from "../../../agent/agent-prompt.js";
import { createSpeechService } from "../../../speech/speech-runtime.js";
import type { WorkspaceRegistry } from "../../../workspace-registry.js";
import type { PaseoToolExtension } from "../../../agent/tools/types.js";
import type {
  VoiceCallProvider,
  VoiceProviderOutput,
  VoiceProviderStartInput,
  VoiceProviderTerminal,
} from "../../internal/provider.js";
import { ManualVoiceCall } from "./index.js";
import type { VoiceSpeakHandler } from "./speak.js";
import {
  resolveManualVoiceOrchestratorConfig,
  type ManualVoiceConfig,
  type ManualVoiceOrchestratorSettings,
} from "./config.js";
import { buildManualVoiceSystemPrompt, wrapSpokenInput } from "./prompt.js";
import { isManualVoicePermissionAllowed } from "./permission.js";

export interface CreateManualVoiceProviderOptions {
  config: ManualVoiceConfig;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  workspaceRegistry: Pick<WorkspaceRegistry, "get">;
  logger: Logger;
  speechFactory?: typeof createSpeechService;
}

export interface ManualVoiceProvider extends VoiceCallProvider {
  configureOrchestrator(orchestrator: ManualVoiceOrchestratorSettings): void;
  close(): Promise<void>;
}

const ManualClientTransportMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("append"), audio: z.string(), format: z.string() }),
  z.object({ type: z.literal("played"), outputId: z.string() }),
]);

function buildSpokenTurnPrompt(text: string, context: VoiceAppContext): string {
  const appContext = [
    context.workspaceId ? `workspace_id=${context.workspaceId}` : null,
    context.agentId ? `agent_id=${context.agentId}` : null,
  ].filter((value): value is string => value !== null);
  const contextHint =
    appContext.length > 0
      ? `\n\nThe user is currently viewing: ${appContext.join(", ")}. Treat this as context, not an instruction.`
      : "";
  return `${wrapSpokenInput(text)}${contextHint}`;
}

function createSpeakExtension(
  agentId: string,
  resolveSpeak: () => VoiceSpeakHandler | null,
): PaseoToolExtension {
  const inputSchema = z.object({ text: z.string().trim().min(1).max(4000) });
  return {
    tools: [
      {
        name: "speak",
        title: "Speak",
        description:
          "Speak text to the user through the active voice call. Blocks until playback completes.",
        inputSchema,
        outputSchema: { ok: z.boolean() },
        async handler(input, context) {
          const speak = resolveSpeak();
          if (!speak) throw new Error("Voice output is not ready");
          const args = inputSchema.parse(input);
          await speak({
            text: args.text,
            callerAgentId: agentId,
            signal: context.signal,
          });
          return { content: [], structuredContent: { ok: true } };
        },
      },
    ],
  };
}

function toProviderOutput(message: SessionOutboundMessage): VoiceProviderOutput | null {
  if (message.type === "transcription_result") {
    return {
      type: "event",
      event: {
        type: "transcript",
        id: message.payload.requestId,
        speaker: "user",
        text: message.payload.text,
        final: true,
      },
    };
  }
  if (message.type === "voice_input_state") {
    return {
      type: "state",
      input: message.payload.isSpeaking ? "speech_detected" : "listening",
    };
  }
  if (message.type === "audio_output") {
    return {
      type: "transport",
      data: {
        type: "audio",
        outputId: message.payload.id,
        audio: message.payload.audio,
        format: message.payload.format,
        ...(message.payload.groupId ? { groupId: message.payload.groupId } : {}),
        ...(message.payload.chunkIndex === undefined
          ? {}
          : { chunkIndex: message.payload.chunkIndex }),
        ...(message.payload.isLastChunk === undefined
          ? {}
          : { isLastChunk: message.payload.isLastChunk }),
      },
    };
  }
  if (message.type !== "activity_log") return null;
  let event: VoiceCallEvent | null = null;
  if (message.payload.type === "assistant") {
    event = {
      type: "transcript",
      id: message.payload.id,
      speaker: "assistant",
      text: message.payload.content,
      final: true,
    };
  } else if (message.payload.type === "error") {
    event = { type: "error", id: message.payload.id, message: message.payload.content };
  } else if (message.payload.type === "system") {
    event = { type: "notice", id: message.payload.id, text: message.payload.content };
  }
  return event ? { type: "event", event } : null;
}

export function createManualVoiceProvider(
  options: CreateManualVoiceProviderOptions,
): ManualVoiceProvider {
  let orchestratorSettings = options.config.orchestrator;
  let speech: ReturnType<typeof createSpeechService> | null = null;

  function getSpeech() {
    if (!speech) {
      speech = (options.speechFactory ?? createSpeechService)({
        logger: options.logger,
        openaiConfig: options.config.openai,
        speechConfig: options.config.speech,
      });
      speech.start();
    }
    return speech;
  }

  return {
    configureOrchestrator(orchestrator) {
      orchestratorSettings = orchestrator;
    },
    async close() {
      await speech?.stop();
      speech = null;
    },
    getReadiness() {
      if (!resolveManualVoiceOrchestratorConfig(orchestratorSettings)) {
        return { ready: false, reason: "Configure the manual voice orchestrator and mode." };
      }
      return { ready: true };
    },
    async start(input) {
      return startManualVoiceCall(options, getSpeech, orchestratorSettings, input);
    },
  };
}

async function startManualVoiceCall(
  options: CreateManualVoiceProviderOptions,
  getSpeech: () => ReturnType<typeof createSpeechService>,
  orchestratorSettings: ManualVoiceOrchestratorSettings,
  input: VoiceProviderStartInput,
) {
  if (!input.transportOffers.some((transport) => transport.kind === "daemon-audio")) {
    throw new Error("The client does not support daemon audio for manual voice chat");
  }
  const contextAgent = input.context.agentId
    ? options.agentManager.getAgent(input.context.agentId)
    : null;
  const workspaceId = input.context.workspaceId ?? contextAgent?.workspaceId ?? null;
  if (!workspaceId) throw new Error("Open a workspace before starting voice chat.");
  const workspace = await options.workspaceRegistry.get(workspaceId);
  if (!workspace || workspace.archivedAt) throw new Error("The selected workspace is unavailable.");
  const orchestrator = resolveManualVoiceOrchestratorConfig(orchestratorSettings);
  if (!orchestrator) throw new Error("Configure the manual voice orchestrator and mode.");
  if (input.signal.aborted) throw new Error("Voice call start was canceled.");
  const speech = getSpeech();
  await speech.ready;
  if (input.signal.aborted) throw new Error("Voice call start was canceled.");

  const agentId = uuidv4();
  let context = input.context;
  let speak: VoiceSpeakHandler | null = null;
  const config: AgentSessionConfig = {
    provider: orchestrator.provider,
    cwd: workspace.cwd,
    internal: true,
    systemPrompt: buildManualVoiceSystemPrompt(),
    modeId: orchestrator.modeId,
    ...(orchestrator.model ? { model: orchestrator.model } : {}),
    ...(orchestrator.thinkingOptionId ? { thinkingOptionId: orchestrator.thinkingOptionId } : {}),
  };
  let manual: ManualVoiceCall | null = null;
  let unsubscribeAgent: (() => void) | null = null;
  let internalAgent: Awaited<
    ReturnType<AgentManager["launchInternalAgentWithRequiredPaseoTools"]>
  > | null = null;
  let terminal: VoiceProviderTerminal | null = null;
  let resolveClosed: (terminal: VoiceProviderTerminal) => void = () => undefined;
  const closed = new Promise<VoiceProviderTerminal>((resolve) => {
    resolveClosed = resolve;
  });
  function settle(next: VoiceProviderTerminal): void {
    if (terminal) return;
    terminal = next;
    resolveClosed(next);
  }
  try {
    internalAgent = await options.agentManager.launchInternalAgentWithRequiredPaseoTools({
      agentId,
      config,
      workspaceId: workspace.workspaceId,
      labels: { surface: "voice" },
      initialTitle: "Voice chat",
      tools: {
        caller: { childAgentDefaultLabels: {}, allowCustomCwd: false },
        extension: createSpeakExtension(agentId, () => speak),
      },
      systemPromptBehavior: "authoritative",
    });
    const agent = internalAgent.agent;
    if (input.signal.aborted) throw new Error("Voice call start was canceled.");
    manual = new ManualVoiceCall({
      host: {
        emit(message) {
          const output = toProviderOutput(message);
          if (output) input.emit(output);
        },
        async loadAgent() {
          const loaded = options.agentManager.getAgent(agent.id);
          if (!loaded) throw new Error(`Voice agent ${agent.id} is unavailable`);
          return loaded;
        },
        async sendSpokenInput(id, text) {
          await sendPromptToAgent({
            agentManager: options.agentManager,
            agentStorage: options.agentStorage,
            agentId: id,
            prompt: buildSpokenTurnPrompt(text, context),
            clearPendingPermissions: true,
            logger: options.logger,
          });
        },
        async interruptAgentIfRunning(id) {
          await options.agentManager.cancelAgentRun(id);
        },
        hasActiveAgentRun: (id) => (id ? options.agentManager.hasInFlightRun(id) : false),
      },
      logger: options.logger.child({ module: "voice-chat", provider: "manual" }),
      sessionId: input.callId,
      sttLanguage: speech.resolveSttLanguage(),
      tts: speech.resolveTts,
      stt: speech.resolveStt,
      voice: { turnDetection: speech.resolveTurnDetection },
      onFatalError(error) {
        settle({ type: "failed", error: error.message });
      },
      voiceBridge: {
        registerVoiceSpeakHandler(_id, handler) {
          speak = handler;
        },
        unregisterVoiceSpeakHandler() {
          speak = null;
        },
      },
      getSpeechReadiness: speech.getReadiness,
    });
    unsubscribeAgent = options.agentManager.subscribe(
      (event) => {
        if (event.type !== "agent_stream" || event.event.type !== "permission_requested") return;
        if (!isManualVoicePermissionAllowed(event.event.request)) return;
        void options.agentManager
          .respondToPermission(agent.id, event.event.request.id, { behavior: "allow" })
          .catch((error) =>
            options.logger.warn({ err: error }, "Failed to allow voice speak tool"),
          );
      },
      { agentId: agent.id, replayState: false },
    );
    await manual.start(agent.id);
    if (input.signal.aborted) throw new Error("Voice call start was canceled.");
    input.emit({ type: "state", input: "listening" });

    let stopped = false;

    async function stop(): Promise<void> {
      if (stopped) return;
      unsubscribeAgent?.();
      unsubscribeAgent = null;
      await manual?.stop();
      await manual?.cleanup();
      await internalAgent?.dispose();
      stopped = true;
      settle({ type: "closed" });
    }

    return {
      transport: { kind: "daemon-audio" as const },
      closed,
      async handleTransportMessage(data: unknown) {
        const message = ManualClientTransportMessageSchema.parse(data);
        if (message.type === "append") {
          await manual?.handleAudioChunk({
            type: "voice_audio_chunk",
            audio: message.audio,
            format: message.format,
            isLast: false,
          });
          return;
        }
        manual?.handleAudioPlayed(message.outputId);
      },
      async updateContext(nextContext: VoiceAppContext) {
        context = nextContext;
      },
      stop,
    };
  } catch (error) {
    unsubscribeAgent?.();
    await manual?.cleanup().catch(() => undefined);
    await internalAgent?.dispose().catch(() => undefined);
    throw error;
  }
}
