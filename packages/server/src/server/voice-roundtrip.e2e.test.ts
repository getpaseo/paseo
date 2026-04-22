import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { createDaemonTestContext, type DaemonTestContext } from "./test-utils/index.js";
import { OpenAITTS } from "./speech/providers/openai/tts.js";
import { OpenAISTT } from "./speech/providers/openai/stt.js";
import { STTManager } from "./agent/stt-manager.js";
import { withTimeout } from "../utils/promise-timeout.js";

const openaiApiKey = process.env.OPENAI_API_KEY ?? null;
const shouldRun = process.env.PASEO_VOICE_ROUNDTRIP_E2E === "1" && Boolean(openaiApiKey);
const speechTest = shouldRun ? test : test.skip;

type VoiceRoundtripProvider = string;

function getVoiceRoundtripConfig(provider: VoiceRoundtripProvider): {
  provider: VoiceRoundtripProvider;
  model: string;
  modeId: string;
  thinkingOptionId?: string;
} {
  switch (provider) {
    case "claude":
      return {
        provider: "claude",
        model: "haiku",
        modeId: "bypassPermissions",
      };
    case "codex":
      return {
        provider: "codex",
        model: "gpt-5.4-mini",
        modeId: "full-access",
        thinkingOptionId: "low",
      };
    case "opencode":
      return {
        provider: "opencode",
        model: "opencode/gpt-5-nano",
        modeId: "default",
      };
  }
}

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

  for (const targetProvider of [
    "claude",
    "codex",
    "opencode",
  ] as const satisfies VoiceRoundtripProvider[]) {
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
          logger,
        );
        const sttProvider = new OpenAISTT(
          {
            apiKey: openaiApiKey!,
            model: "gpt-4o-mini-transcribe",
          },
          logger,
        );
        const sttOutput = new STTManager("voice-roundtrip-e2e", logger, sttProvider);

        const voiceCwd = mkdtempSync(
          path.join(tmpdir(), `voice-roundtrip-agent-${targetProvider}-`),
        );
        const voiceAgent = await withTimeout(
          ctx.client.createAgent({
            config: {
              ...getVoiceRoundtripConfig(targetProvider),
              cwd: voiceCwd,
            },
          }),
          30000,
          "Timed out during createVoiceTargetAgent after 30000ms",
        );
        const voiceAgentId = voiceAgent.id;
        const voiceMode = await withTimeout(
          ctx.client.setVoiceMode(true, voiceAgentId),
          15000,
          "Timed out during setVoiceMode after 15000ms",
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
          ttsProvider.synthesizeSpeech("Use the speak tool and say exactly round trip successful."),
          30000,
          "Timed out during synthesizeInputAudio after 30000ms",
        );
        const inputPcm = await withTimeout(
          streamToBuffer(inputSpeech.stream),
          15000,
          "Timed out during collectInputAudio after 15000ms",
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
              },
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
              const chunk = inputPcm.subarray(
                offset,
                Math.min(inputPcm.length, offset + chunkBytes),
              );
              const isLast = offset + chunkBytes >= inputPcm.length;
              await withTimeout(
                ctx.client.sendVoiceAudioChunk(chunk.toString("base64"), format, isLast),
                5000,
                "Timed out during sendVoiceAudioChunk after 5000ms",
              );
            }
            const transcript = await withTimeout(
              transcriptPromise,
              35000,
              "Timed out during waitForTranscription after 35000ms",
            );
            if (transcript.text.trim().length === 0) {
              throw new Error(`empty transcription (lowConfidence=${transcript.isLowConfidence})`);
            }
            return await withTimeout(
              outputAudioPromise,
              95000,
              "Timed out during waitForAudioOutput after 95000ms",
            );
          } catch (error) {
            throw new Error(
              `${error instanceof Error ? error.message : String(error)} | requestedVoiceAgentId=${voiceAgentId} | timelineTools=${JSON.stringify(timelineTools)} | timelineToolAgentIds=${JSON.stringify(Array.from(timelineToolAgentIds))} | activityErrors=${JSON.stringify(activityErrors)}`,
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
          sttOutput.transcribe(outputRaw, outputFormat, {
            label: "voice-roundtrip-output",
          }),
          60000,
          "Timed out during transcribeOutputAudio after 60000ms",
        );
        const normalized = transcription.text.trim().toLowerCase();

        expect(normalized.length).toBeGreaterThan(0);
        expect(normalized).toMatch(/round|trip|successful/);
      },
      180000,
    );
  }
});
