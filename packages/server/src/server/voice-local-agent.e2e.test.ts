import { afterAll, beforeAll, describe, expect, test } from "vitest";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import pino from "pino";

import { createDaemonTestContext, type DaemonTestContext } from "./test-utils/index.js";
import { getFullAccessConfig } from "./daemon-e2e/agent-configs.js";
import { OpenAITTS } from "./speech/providers/openai/tts.js";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";

type SessionMessage<T extends SessionOutboundMessage["type"]> = Extract<
  SessionOutboundMessage,
  { type: T }
>;

function makeTranscriptionHandler(callId: string, resolve: (value: string) => void) {
  return (msg: SessionMessage<"voice.call.event">) => {
    if (msg.payload.callId !== callId || msg.payload.event.type !== "transcript") return;
    if (msg.payload.event.speaker !== "user") return;
    const text = msg.payload.event.text.trim();
    if (!text) return;
    resolve(text);
  };
}

function makeErrorHandler(callId: string, reject: (error: Error) => void) {
  return (msg: SessionMessage<"voice.call.event">) => {
    if (msg.payload.callId !== callId || msg.payload.event.type !== "error") return;
    reject(new Error(msg.payload.event.message));
  };
}

function makeSpokenReplyHandler(callId: string, resolve: (value: string) => void) {
  return (msg: SessionMessage<"voice.call.event">) => {
    if (msg.payload.callId !== callId || msg.payload.event.type !== "transcript") return;
    if (msg.payload.event.speaker !== "assistant") return;
    resolve(msg.payload.event.text);
  };
}

const openaiApiKey = process.env.OPENAI_API_KEY ?? null;
const shouldRun =
  process.env.PASEO_VOICE_LOCAL_AGENT_E2E === "1" && Boolean(openaiApiKey) && !process.env.CI;

function waitForSignal<T>(
  timeoutMs: number,
  setup: (resolve: (value: T) => void, reject: (error: Error) => void) => () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let cleanup: (() => void) | null = null;
    const timeout = setTimeout(() => {
      cleanup?.();
      reject(new Error(`Timeout waiting for event after ${timeoutMs}ms`));
    }, timeoutMs);

    cleanup = setup(
      (value) => {
        clearTimeout(timeout);
        cleanup?.();
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        cleanup?.();
        reject(error);
      },
    );
  });
}

(shouldRun ? describe : describe.skip)("voice local-agent e2e", () => {
  let ctx: DaemonTestContext;

  beforeAll(async () => {
    ctx = await createDaemonTestContext({
      agentClients: {},
      openai: { stt: { apiKey: openaiApiKey! }, tts: { apiKey: openaiApiKey! } },
      speech: {
        providers: {
          dictationStt: { provider: "openai", explicit: true },
          voiceStt: { provider: "openai", explicit: true },
          voiceTts: { provider: "openai", explicit: true },
        },
      },
      manualVoice: {
        orchestrator: {
          provider: "codex",
          model: "gpt-5.4-mini",
          modeId: "full-access",
          thinkingOptionId: null,
        },
        openai: { stt: { apiKey: openaiApiKey! }, tts: { apiKey: openaiApiKey! } },
        speech: {
          providers: {
            dictationStt: { provider: "openai", explicit: false, enabled: false },
            voiceTurnDetection: { provider: "local", explicit: true },
            voiceStt: { provider: "openai", explicit: true },
            voiceTts: { provider: "openai", explicit: true },
          },
          sttLanguages: { dictation: "en", voice: "en" },
        },
      },
    });
  }, 120000);

  afterAll(async () => {
    await ctx.cleanup();
  }, 60000);

  test("routes voice turns through local agent speak tool", async () => {
    const logger = pino({ level: "silent" });
    const ttsProvider = new OpenAITTS(
      {
        apiKey: openaiApiKey!,
        responseFormat: "pcm",
        voice: "alloy",
      },
      logger,
    );

    const voiceCwd = mkdtempSync(path.join(tmpdir(), "voice-local-agent-"));
    const workspaceResult = await ctx.client.createWorkspace({
      source: { kind: "directory", path: voiceCwd },
      title: "Voice local agent",
    });
    if (!workspaceResult.workspace) {
      throw new Error(workspaceResult.error ?? "Failed to create voice test workspace");
    }
    const targetAgent = await ctx.client.createAgent({
      config: {
        ...getFullAccessConfig("codex"),
        cwd: voiceCwd,
      },
      workspaceId: workspaceResult.workspace.workspaceId,
    });
    const voiceCall = await ctx.client.startVoiceCall(
      { workspaceId: workspaceResult.workspace.workspaceId, agentId: targetAgent.id },
      [{ kind: "daemon-audio" }],
    );

    const transcriptionPromise = waitForSignal<string>(120000, (resolve, reject) => {
      const offTranscript = ctx.client.on(
        "voice.call.event",
        makeTranscriptionHandler(voiceCall.callId, resolve),
      );
      const offError = ctx.client.on(
        "voice.call.event",
        makeErrorHandler(voiceCall.callId, reject),
      );
      return () => {
        offTranscript();
        offError();
      };
    });

    const spokenReplyPromise = waitForSignal<string>(120000, (resolve, reject) => {
      const offStream = ctx.client.on(
        "voice.call.event",
        makeSpokenReplyHandler(voiceCall.callId, resolve),
      );
      const offError = ctx.client.on(
        "voice.call.event",
        makeErrorHandler(voiceCall.callId, reject),
      );
      return () => {
        offStream();
        offError();
      };
    });

    const inputSpeech = await ttsProvider.synthesizeSpeech(
      "Use the speak tool and say exactly local agent check.",
    );
    const buffers: Buffer[] = [];
    for await (const chunk of inputSpeech.stream as AsyncIterable<unknown>) {
      buffers.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike));
    }
    const pcm = Buffer.concat(buffers);
    const chunkBytes = 4800;
    for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
      const chunk = pcm.subarray(offset, Math.min(pcm.length, offset + chunkBytes));
      ctx.client.sendVoiceCallTransportMessage(voiceCall.callId, {
        type: "append",
        audio: chunk.toString("base64"),
        format: "audio/pcm;rate=24000;bits=16",
      });
    }

    const [transcript, spokenReply] = await Promise.all([transcriptionPromise, spokenReplyPromise]);

    await ctx.client.stopVoiceCall(voiceCall.callId).catch(() => undefined);
    rmSync(voiceCwd, { recursive: true, force: true });

    expect(transcript.length).toBeGreaterThan(0);
    expect(spokenReply.toLowerCase()).toContain("local agent check");

    const agents = await ctx.client.fetchAgents();
    expect(agents.some((agent) => String(agent.labels?.surface ?? "") === "voice")).toBe(false);
  }, 180000);
});
