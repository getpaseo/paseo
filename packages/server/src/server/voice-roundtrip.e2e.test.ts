import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "./test-utils/index.js";
import { getFullAccessConfig, type AgentProvider } from "./daemon-e2e/agent-configs.js";
import { OpenAITTS } from "./speech/providers/openai/tts.js";
import { OpenAISTT } from "./speech/providers/openai/stt.js";
import { STTManager } from "./agent/stt-manager.js";

const openaiApiKey = process.env.OPENAI_API_KEY ?? null;
const shouldRun = process.env.PASEO_VOICE_ROUNDTRIP_E2E === "1" && Boolean(openaiApiKey);
const speechTest = shouldRun ? test : test.skip;

function waitForSignal<T>(
  timeoutMs: number,
  setup: (
    resolve: (value: T) => void,
    reject: (error: Error) => void
  ) => () => void
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
      }
    );
  });
}

async function withTimeout<T>(
  label: string,
  timeoutMs: number,
  task: Promise<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out during ${label} after ${timeoutMs}ms`));
    }, timeoutMs);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("voice roundtrip e2e", () => {
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
    });
  }, 60000);

  afterAll(async () => {
    await ctx.cleanup();
  }, 60000);

  for (const targetProvider of ["claude", "codex"] as const satisfies AgentProvider[]) {
    speechTest(
      `full roundtrip (${targetProvider}): voice input audio -> voice agent -> output audio -> transcribed output`,
      async () => {
      const logger = pino({ level: "silent" });
      const ttsProvider = new OpenAITTS(
        {
          apiKey: openaiApiKey!,
          responseFormat: "pcm",
          voice: "alloy",
        },
        logger
      );
      const sttProvider = new OpenAISTT(
        {
          apiKey: openaiApiKey!,
          model: "gpt-4o-mini-transcribe",
        },
        logger
      );
      const sttOutput = new STTManager("voice-roundtrip-e2e", logger, sttProvider);

      const voiceCwd = mkdtempSync(
        path.join(tmpdir(), `voice-roundtrip-agent-${targetProvider}-`)
      );
      const voiceAgent = await withTimeout(
        "createVoiceTargetAgent",
        30000,
        ctx.client.createAgent({
          config: {
            ...getFullAccessConfig(targetProvider),
            cwd: voiceCwd,
          },
        })
      );
      const voiceAgentId = voiceAgent.id;
      const voiceMode = await withTimeout(
        "setVoiceMode",
        15000,
        ctx.client.setVoiceMode(true, voiceAgentId)
      );
      expect(voiceMode.accepted).toBe(true);
      expect(voiceMode.enabled).toBe(true);
      const timelineTools: string[] = [];
      const timelineToolAgentIds = new Set<string>();
      const activityErrors: string[] = [];

      const offStream = ctx.client.on("agent_stream", (message) => {
        if (message.type !== "agent_stream") {
          return;
        }
        if (message.payload.event.type !== "timeline") {
          return;
        }
        const item = message.payload.event.item;
        if (item.type !== "tool_call") {
          return;
        }
        timelineToolAgentIds.add(message.payload.agentId);
        timelineTools.push(String(item.name ?? ""));
      });
      const offErrors = ctx.client.on("activity_log", (message) => {
        if (message.type !== "activity_log") {
          return;
        }
        if (message.payload.type !== "error") {
          return;
        }
        activityErrors.push(String(message.payload.content ?? ""));
      });

      const inputSpeech = await withTimeout(
        "synthesizeInputAudio",
        30000,
        ttsProvider.synthesizeSpeech(
          "Use the speak tool and say exactly round trip successful."
        )
      );
      const inputPcm = await withTimeout(
        "collectInputAudio",
        15000,
        streamToBuffer(inputSpeech.stream)
      );
      const outputAudio = await (async () => {
        try {
          const transcriptPromise = waitForSignal<{ text: string; isLowConfidence: boolean }>(
            30000,
            (resolve) => {
              const offTranscript = ctx.client.on("transcription_result", (message) => {
                if (message.type !== "transcription_result") {
                  return;
                }
                resolve({
                  text: String(message.payload.text ?? ""),
                  isLowConfidence: Boolean(message.payload.isLowConfidence),
                });
              });
              return () => {
                offTranscript();
              };
            }
          );

          const outputAudioPromise = waitForSignal<{
            format: string;
            chunks: Buffer[];
          }>(90000, (resolve, reject) => {
            let targetGroupId: string | null = null;
            const chunks: Array<{ index: number; bytes: Buffer }> = [];
            let format = "pcm";

            const offAudio = ctx.client.on("audio_output", (message) => {
              if (message.type !== "audio_output") {
                return;
              }
              const payload = message.payload;
              if (!targetGroupId) {
                targetGroupId = payload.groupId;
                format = payload.format;
              }
              if (payload.groupId !== targetGroupId) {
                return;
              }
              chunks.push({
                index: payload.chunkIndex,
                bytes: Buffer.from(payload.audio, "base64"),
              });
              if (payload.isLastChunk) {
                chunks.sort((a, b) => a.index - b.index);
                resolve({
                  format,
                  chunks: chunks.map((entry) => entry.bytes),
                });
              }
            });

            const offError = ctx.client.on("activity_log", (message) => {
              if (message.type !== "activity_log") {
                return;
              }
              if (message.payload.type !== "error") {
                return;
              }
              reject(new Error(String(message.payload.content)));
            });

            return () => {
              offAudio();
              offError();
            };
          });

          const format = "audio/pcm;rate=24000;bits=16";
          const chunkBytes = 4800; // 100ms @ 24kHz mono PCM16
          for (let offset = 0; offset < inputPcm.length; offset += chunkBytes) {
            const chunk = inputPcm.subarray(offset, Math.min(inputPcm.length, offset + chunkBytes));
            const isLast = offset + chunkBytes >= inputPcm.length;
            await withTimeout(
              "sendVoiceAudioChunk",
              5000,
              ctx.client.sendVoiceAudioChunk(chunk.toString("base64"), format, isLast)
            );
          }
          const transcript = await withTimeout("waitForTranscription", 35000, transcriptPromise);
          if (transcript.text.trim().length === 0) {
            throw new Error(
              `empty transcription (lowConfidence=${transcript.isLowConfidence})`
            );
          }
          return await withTimeout("waitForAudioOutput", 95000, outputAudioPromise);
        } catch (error) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)} | requestedVoiceAgentId=${voiceAgentId} | timelineTools=${JSON.stringify(timelineTools)} | timelineToolAgentIds=${JSON.stringify(Array.from(timelineToolAgentIds))} | activityErrors=${JSON.stringify(activityErrors)}`
          );
        } finally {
          offStream();
          offErrors();
          await ctx.client.setVoiceMode(false).catch(() => undefined);
          rmSync(voiceCwd, { recursive: true, force: true });
        }
      })();

      const outputRaw = Buffer.concat(outputAudio.chunks);
      const outputFormat =
        outputAudio.format === "pcm"
          ? "audio/pcm;rate=24000;bits=16"
          : outputAudio.format.includes("wav")
            ? "audio/wav"
            : `audio/${outputAudio.format}`;
      const transcription = await withTimeout(
        "transcribeOutputAudio",
        60000,
        sttOutput.transcribe(outputRaw, outputFormat, {
          label: "voice-roundtrip-output",
        })
      );
      const normalized = transcription.text.trim().toLowerCase();

      expect(normalized.length).toBeGreaterThan(0);
      expect(normalized).toMatch(/round|trip|successful/);
      },
      180000
    );
  }
});
