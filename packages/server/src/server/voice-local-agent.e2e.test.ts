import { afterAll, beforeAll, describe, expect, test } from "vitest";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import pino from "pino";

import { createDaemonTestContext, type DaemonTestContext } from "./test-utils/index.js";
import { getFullAccessConfig } from "./daemon-e2e/agent-configs.js";
import { OpenAITTS } from "./speech/providers/openai/tts.js";
import type { SessionOutboundMessage } from "../shared/messages.js";

type SessionMessage<T extends SessionOutboundMessage["type"]> = Extract<
  SessionOutboundMessage,
  { type: T }
>;

function makeTranscriptionHandler(resolve: (value: string) => void) {
  return (msg: SessionMessage<"transcription_result">) => {
    if (msg.type !== "transcription_result") return;
    const text = (msg.payload.text ?? "").trim();
    if (!text) return;
    resolve(text);
  };
}

function makeErrorHandler(reject: (error: Error) => void) {
  return (msg: SessionMessage<"activity_log">) => {
    if (msg.type !== "activity_log") return;
    if (msg.payload.type !== "error") return;
    reject(new Error(msg.payload.content));
  };
}

function makeSpeakToolHandler(resolve: (value: string) => void) {
  return (msg: SessionMessage<"agent_stream">) => {
    if (msg.type !== "agent_stream") return;
    if (msg.payload.event.type !== "timeline") return;
    const item = msg.payload.event.item;
    if (item.type !== "tool_call") return;
    const name = item.name ?? "";
    if (!name.toLowerCase().includes("speak")) return;
    resolve(name);
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
      openai: { apiKey: openaiApiKey! },
      speech: {
        providers: {
          dictationStt: { provider: "openai", explicit: true },
          voiceStt: { provider: "openai", explicit: true },
          voiceTts: { provider: "openai", explicit: true },
        },
      },
      voiceLlmProvider: "codex",
      voiceLlmProviderExplicit: true,
      voiceLlmModel: "gpt-5.4-mini",
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
    const targetAgent = await ctx.client.createAgent({
      config: {
        ...getFullAccessConfig("codex"),
        cwd: voiceCwd,
      },
    });
    const voiceMode = await ctx.client.setVoiceMode(true, targetAgent.id);
    expect(voiceMode.accepted).toBe(true);

    const transcriptionPromise = waitForSignal<string>(120000, (resolve, reject) => {
      const offTranscript = ctx.client.on(
        "transcription_result",
        makeTranscriptionHandler(resolve),
      );
      const offError = ctx.client.on("activity_log", makeErrorHandler(reject));
      return () => {
        offTranscript();
        offError();
      };
    });

    const speakToolPromise = waitForSignal<string>(120000, (resolve, reject) => {
      const offStream = ctx.client.on("agent_stream", makeSpeakToolHandler(resolve));
      const offError = ctx.client.on("activity_log", makeErrorHandler(reject));
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
      const isLast = offset + chunkBytes >= pcm.length;
      await ctx.client.sendVoiceAudioChunk(
        chunk.toString("base64"),
        "audio/pcm;rate=24000;bits=16",
        isLast,
      );
    }

    const [transcript, speakToolName] = await Promise.all([transcriptionPromise, speakToolPromise]);

    await ctx.client.setVoiceMode(false).catch(() => undefined);
    rmSync(voiceCwd, { recursive: true, force: true });

    expect(transcript.length).toBeGreaterThan(0);
    expect(speakToolName.toLowerCase()).toContain("speak");

    const agents = await ctx.client.fetchAgents();
    expect(agents.some((agent) => String(agent.labels?.surface ?? "") === "voice")).toBe(false);
  }, 180000);
});
