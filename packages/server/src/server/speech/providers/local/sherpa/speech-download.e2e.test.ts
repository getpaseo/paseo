import { describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pino from "pino";

import { ensureSherpaOnnxModels, getSherpaOnnxModelDir } from "./model-downloader.js";
import type { SherpaOnnxModelId } from "./model-catalog.js";
import { createDaemonTestContext } from "../../../../test-utils/index.js";
import { parsePcm16MonoWav, wordSimilarity } from "../../../../test-utils/dictation-e2e.js";
import { SherpaOnnxTTS } from "./sherpa-tts.js";
import { PocketTtsOnnxTTS } from "../pocket/pocket-tts-onnx.js";
import { SherpaOnlineRecognizerEngine } from "./sherpa-online-recognizer.js";
import { SherpaOnnxSTT } from "./sherpa-stt.js";
import { SherpaOfflineRecognizerEngine } from "./sherpa-offline-recognizer.js";
import { SherpaOnnxParakeetSTT } from "./sherpa-parakeet-stt.js";

const RUN = process.env.PASEO_SPEECH_E2E_DOWNLOAD === "1";
const downloadTest = RUN ? test : test.skip;

type ModelSet = "zipformer-kitten" | "parakeet-pocket";

function getModelSet(): ModelSet {
  const raw = (process.env.PASEO_SPEECH_E2E_MODEL_SET ?? "parakeet-pocket").trim().toLowerCase();
  if (raw === "zipformer-kitten" || raw === "zipformer") return "zipformer-kitten";
  if (raw === "parakeet-pocket" || raw === "parakeet") return "parakeet-pocket";
  throw new Error(`Unknown PASEO_SPEECH_E2E_MODEL_SET: ${raw}`);
}

async function readFixtureWav(): Promise<Buffer> {
  const fixturePath = path.resolve(process.cwd(), "..", "app", "e2e", "fixtures", "recording.wav");
  return import("node:fs/promises").then((fs) => fs.readFile(fixturePath));
}

async function readBaseline(): Promise<string> {
  const baselinePath = path.resolve(process.cwd(), "..", "app", "e2e", "fixtures", "recording.baseline.txt");
  return import("node:fs/promises").then((fs) => fs.readFile(baselinePath, "utf-8")).then((t) => t.trim());
}

async function readAllChunks(stream: NodeJS.ReadableStream): Promise<{ chunks: Buffer[]; combined: Buffer }> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as any) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return { chunks, combined: Buffer.concat(chunks) };
}

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

function toAudioPcmFormat(format: string): string {
  const trimmed = format.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("audio/pcm")) {
    return trimmed;
  }
  if (lower.startsWith("pcm")) {
    const rest = trimmed.replace(/^pcm;?/i, "");
    return rest ? `audio/pcm;${rest}` : "audio/pcm";
  }
  // Fall back to treating it as a suffix (e.g. "rate=24000")
  return `audio/pcm;${trimmed}`;
}

describe("speech models (download E2E)", () => {
  downloadTest(
    "downloads models and runs streaming STT + streaming TTS",
    async () => {
      const logger = pino({ level: "silent" });
      const set = getModelSet();

      const paseoHomeRoot = mkdtempSync(path.join(tmpdir(), "paseo-speech-download-"));
      const modelsDir = path.join(paseoHomeRoot, ".paseo", "models", "local-speech");

      const modelIds: SherpaOnnxModelId[] =
        set === "parakeet-pocket"
          ? ["parakeet-tdt-0.6b-v3-int8", "pocket-tts-onnx-int8"]
          : ["zipformer-bilingual-zh-en-2023-02-20", "kitten-nano-en-v0_1-fp16"];

      await ensureSherpaOnnxModels({
        modelsDir,
        modelIds,
        autoDownload: true,
        logger,
      });

      const ctx = await createDaemonTestContext({
        paseoHomeRoot,
        dictationFinalTimeoutMs: 8000,
        speech: {
          dictationSttProvider: "local",
          voiceSttProvider: "local",
          voiceTtsProvider: "local",
          local: {
            modelsDir,
            autoDownload: false,
          },
          dictationLocalSttModel:
            set === "parakeet-pocket"
              ? "parakeet-tdt-0.6b-v3-int8"
              : "zipformer-bilingual-zh-en-2023-02-20",
          voiceLocalSttModel:
            set === "parakeet-pocket"
              ? "parakeet-tdt-0.6b-v3-int8"
              : "zipformer-bilingual-zh-en-2023-02-20",
          voiceLocalTtsModel:
            set === "parakeet-pocket" ? "pocket-tts-onnx-int8" : "kitten-nano-en-v0_1-fp16",
        },
      });

      try {
        const wav = await readFixtureWav();
        const { sampleRate, pcm16 } = parsePcm16MonoWav(wav);
        expect(sampleRate).toBe(16000);
        const format = "audio/pcm;rate=16000;bits=16";

        // Streaming STT: dictation path (verifies websocket streaming + partials + final)
        const dictationId = `dict-download-${Date.now()}`;
        let partialCount = 0;
        const unsubscribe = ctx.client.on("dictation_stream_partial", (message) => {
          if (message.type !== "dictation_stream_partial") return;
          if (message.payload.dictationId !== dictationId) return;
          partialCount += 1;
        });

        await ctx.client.startDictationStream(dictationId, format);
        const chunkBytes = 3200; // 100ms @ 16kHz mono PCM16
        let seq = 0;
        for (let offset = 0; offset < pcm16.length; offset += chunkBytes) {
          const chunk = pcm16.subarray(offset, Math.min(pcm16.length, offset + chunkBytes));
          ctx.client.sendDictationStreamChunk(dictationId, seq, chunk.toString("base64"), format);
          seq += 1;
        }
        const finalSeq = seq - 1;
        const dictationFinal = await ctx.client.finishDictationStream(dictationId, finalSeq);
        unsubscribe();

        expect(dictationFinal.text.toLowerCase()).toContain("voice note");
        const baseline = await readBaseline();
        expect(wordSimilarity(dictationFinal.text, baseline)).toBeGreaterThan(0.45);
        expect(partialCount).toBeGreaterThan(0);

        // Voice-mode STT: chunked upload until isLast=true
        const transcriptionPromise = waitForSignal<string>(30000, (resolve, reject) => {
          const offResult = ctx.client.on("transcription_result", (message) => {
            if (message.type !== "transcription_result") return;
            resolve(message.payload.text);
          });
          const offError = ctx.client.on("activity_log", (message) => {
            if (message.type !== "activity_log") return;
            const payload = message.payload as { type?: unknown; content?: unknown };
            if (payload.type !== "error") return;
            const content = typeof payload.content === "string" ? payload.content : null;
            if (!content) return;
            reject(new Error(content));
          });
          return () => {
            offResult();
            offError();
          };
        });

        await ctx.client.setVoiceConversation(true, randomUUID());
        for (let offset = 0; offset < pcm16.length; offset += chunkBytes) {
          const chunk = pcm16.subarray(offset, Math.min(pcm16.length, offset + chunkBytes));
          const isLast = offset + chunkBytes >= pcm16.length;
          await ctx.client.sendVoiceAudioChunk(chunk.toString("base64"), format, isLast);
        }
        const voiceText = (await transcriptionPromise).trim().toLowerCase();
        if (voiceText.length > 0) {
          expect(voiceText).toContain("voice note");
        }
        await ctx.client.setVoiceConversation(false);

        // Streaming TTS: generate locally from downloaded model and validate chunking.
        const ttsText = "This is a voice note.";
        if (set === "parakeet-pocket") {
          const modelDir = getSherpaOnnxModelDir(modelsDir, "pocket-tts-onnx-int8");
          const tts = await PocketTtsOnnxTTS.create({ modelDir, precision: "int8", targetChunkMs: 50 }, logger);
          const { stream, format: ttsFormat } = await tts.synthesizeSpeech(ttsText);
          const { chunks, combined } = await readAllChunks(stream);

          expect(ttsFormat).toMatch(/rate=\d+/);
          expect(chunks.length).toBeGreaterThan(3);
          expect(combined.byteLength).toBeGreaterThan(2000);

          // Round trip: TTS -> STT (offline parakeet)
          const sttModelDir = getSherpaOnnxModelDir(modelsDir, "parakeet-tdt-0.6b-v3-int8");
          const engine = new SherpaOfflineRecognizerEngine(
            {
              model: {
                kind: "nemo_transducer",
                encoder: `${sttModelDir}/encoder.int8.onnx`,
                decoder: `${sttModelDir}/decoder.int8.onnx`,
                joiner: `${sttModelDir}/joiner.int8.onnx`,
                tokens: `${sttModelDir}/tokens.txt`,
              },
              numThreads: 2,
              debug: 0,
            },
            logger
          );
          const stt = new SherpaOnnxParakeetSTT({ engine }, logger);
          const rt = await stt.transcribeAudio(combined, toAudioPcmFormat(ttsFormat));
          engine.free();
          expect(wordSimilarity(rt.text, ttsText)).toBeGreaterThan(0.25);
        } else {
          const ttsModelDir = path.join(modelsDir, "kitten-nano-en-v0_1-fp16");
          const tts = new SherpaOnnxTTS({ preset: "kitten-nano-en-v0_1-fp16", modelDir: ttsModelDir }, logger);
          const { stream, format: ttsFormat } = await tts.synthesizeSpeech(ttsText);
          const { chunks, combined } = await readAllChunks(stream);
          tts.free();

          expect(ttsFormat).toMatch(/rate=\d+/);
          expect(chunks.length).toBeGreaterThan(3);
          expect(combined.byteLength).toBeGreaterThan(2000);

          // Round trip: TTS -> STT (online zipformer, offline segment)
          const sttModelDir = path.join(modelsDir, "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20");
          const engine = new SherpaOnlineRecognizerEngine(
            {
              model: {
                kind: "transducer",
                encoder: `${sttModelDir}/encoder-epoch-99-avg-1.onnx`,
                decoder: `${sttModelDir}/decoder-epoch-99-avg-1.onnx`,
                joiner: `${sttModelDir}/joiner-epoch-99-avg-1.onnx`,
                tokens: `${sttModelDir}/tokens.txt`,
                modelType: "zipformer",
              },
              numThreads: 1,
              debug: 0,
            },
            logger
          );
          const stt = new SherpaOnnxSTT({ engine }, logger);
          const rt = await stt.transcribeAudio(combined, toAudioPcmFormat(ttsFormat));
          engine.free();
          expect(wordSimilarity(rt.text, ttsText)).toBeGreaterThan(0.25);
        }
      } finally {
        await ctx.cleanup();
      }
    },
    15 * 60_000
  );
});
