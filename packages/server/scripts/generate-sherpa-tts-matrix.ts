import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createRootLogger } from "../src/server/logger.js";
import { resolveJunctionHome } from "../src/server/junction-home.js";
import { float32ToPcm16le, parsePcmRateFromFormat } from "../src/server/speech/audio.js";
import {
  ensureLocalSpeechModels,
  getLocalSpeechModelDir,
  type LocalTtsModelId,
} from "../src/server/speech/providers/local/models.js";
import { PocketTtsOnnxTTS } from "../src/server/speech/providers/local/pocket/pocket-tts-onnx.js";
import {
  LOCAL_TTS_MODEL_IDS,
  LocalTtsModelIdSchema,
} from "../src/server/speech/providers/local/sherpa/model-catalog.js";
import { loadSherpaOnnxNode } from "../src/server/speech/providers/local/sherpa/sherpa-onnx-node-loader.js";

const DEFAULT_SAMPLE_TEXT =
  "Junction keeps your coding agents in your pocket, with fast local speech and reliable remote control.";

type ScriptOptions = {
  modelsDir: string;
  outputDir: string;
  text: string;
  speed: number;
  modelIds: LocalTtsModelId[];
};

type GeneratedSample = {
  modelId: LocalTtsModelId;
  voiceLabel: string;
  speakerId: number | null;
  sampleRate: number;
  durationSeconds: number;
  relativePath: string;
};

function usage(): string {
  return [
    "Generate a local Sherpa/Pocket TTS sample matrix.",
    "",
    "Options:",
    "  --models-dir <dir>   Directory for downloaded local speech models",
    "  --output-dir <dir>   Directory where WAV samples are written",
    "  --model <id>         TTS model to include (repeatable)",
    "  --text <sentence>    Sample sentence used for every generated file",
    "  --speed <number>     TTS speed multiplier for Sherpa models (default: 1.0)",
    "  --help               Show this help",
    "",
    `Known TTS model IDs: ${LOCAL_TTS_MODEL_IDS.join(", ")}`,
  ].join("\n");
}

function parsePositiveNumber(raw: string, flag: string): number {
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number (received: ${raw})`);
  }
  return parsed;
}

function parseArgs(argv: string[]): ScriptOptions {
  const junctionHome = resolveJunctionHome();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  let modelsDir = process.env.JUNCTION_LOCAL_MODELS_DIR ?? `${junctionHome}/models/local-speech`;
  let outputDir = path.resolve(process.cwd(), ".debug", "sherpa-tts-matrix", timestamp);
  let text = DEFAULT_SAMPLE_TEXT;
  let speed = parsePositiveNumber(process.env.JUNCTION_VOICE_LOCAL_TTS_SPEED ?? "1.0", "--speed");
  const requestedModelIds: LocalTtsModelId[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help") {
      // eslint-disable-next-line no-console
      console.log(usage());
      process.exit(0);
    }

    if (arg === "--models-dir") {
      modelsDir = path.resolve(argv[i + 1] ?? modelsDir);
      i += 1;
      continue;
    }

    if (arg === "--output-dir") {
      outputDir = path.resolve(argv[i + 1] ?? outputDir);
      i += 1;
      continue;
    }

    if (arg === "--text") {
      text = argv[i + 1] ?? text;
      i += 1;
      continue;
    }

    if (arg === "--speed") {
      const raw = argv[i + 1];
      if (!raw) {
        throw new Error("--speed requires a value");
      }
      speed = parsePositiveNumber(raw, "--speed");
      i += 1;
      continue;
    }

    if (arg === "--model") {
      const raw = argv[i + 1];
      if (!raw) {
        throw new Error("--model requires a value");
      }
      requestedModelIds.push(LocalTtsModelIdSchema.parse(raw));
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Sample text cannot be empty");
  }

  const modelIds =
    requestedModelIds.length > 0
      ? Array.from(new Set(requestedModelIds))
      : [...LOCAL_TTS_MODEL_IDS];

  return {
    modelsDir,
    outputDir,
    text: trimmed,
    speed,
    modelIds,
  };
}

function pcm16MonoToWavBuffer(pcm16: Buffer, sampleRate: number): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const headerSize = 44;
  const wav = Buffer.alloc(headerSize + pcm16.length);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcm16.length, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcm16.length, 40);
  pcm16.copy(wav, 44);

  return wav;
}

function sanitizeFilePart(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function toFloatSamples(audio: unknown): Float32Array {
  const raw = (audio as { samples?: unknown })?.samples;
  if (raw instanceof Float32Array) {
    return raw;
  }
  if (Array.isArray(raw)) {
    return Float32Array.from(raw as number[]);
  }
  throw new Error("Unexpected Sherpa TTS output: missing Float32 samples");
}

function toSampleRate(audio: unknown, fallback: number): number {
  const sampleRate = (audio as { sampleRate?: unknown })?.sampleRate;
  if (typeof sampleRate === "number" && Number.isFinite(sampleRate) && sampleRate > 0) {
    return sampleRate;
  }
  return fallback;
}

function createSherpaOfflineTts(params: {
  modelId: "kokoro-en-v0_19" | "kitten-nano-en-v0_1-fp16";
  modelDir: string;
  speed: number;
}): { tts: any; speed: number } {
  const sherpa = loadSherpaOnnxNode();
  const model =
    params.modelId === "kokoro-en-v0_19"
      ? {
          kokoro: {
            model: `${params.modelDir}/model.onnx`,
            voices: `${params.modelDir}/voices.bin`,
            tokens: `${params.modelDir}/tokens.txt`,
            dataDir: `${params.modelDir}/espeak-ng-data`,
            lengthScale: 1.0,
          },
        }
      : {
          kitten: {
            model: `${params.modelDir}/model.fp16.onnx`,
            voices: `${params.modelDir}/voices.bin`,
            tokens: `${params.modelDir}/tokens.txt`,
            dataDir: `${params.modelDir}/espeak-ng-data`,
            lengthScale: 1.0,
          },
        };

  return {
    tts: new sherpa.OfflineTts({
      model,
      numThreads: 2,
      provider: "cpu",
      maxNumSentences: 1,
    }),
    speed: params.speed,
  };
}

async function readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function toCsv(rows: GeneratedSample[]): string {
  const header = [
    "model_id",
    "voice_label",
    "speaker_id",
    "sample_rate",
    "duration_seconds",
    "relative_path",
  ];

  const lines = [header.join(",")];
  for (const row of rows) {
    const cells = [
      row.modelId,
      row.voiceLabel,
      row.speakerId === null ? "" : String(row.speakerId),
      String(row.sampleRate),
      row.durationSeconds.toFixed(3),
      row.relativePath,
    ];

    lines.push(
      cells
        .map((cell) => {
          const escaped = cell.replace(/"/g, "\"\"");
          return escaped.includes(",") ? `"${escaped}"` : escaped;
        })
        .join(",")
    );
  }
  return `${lines.join("\n")}\n`;
}

const logger = createRootLogger({ level: "info", format: "pretty" });
const options = parseArgs(process.argv.slice(2));

logger.info(
  {
    modelsDir: options.modelsDir,
    outputDir: options.outputDir,
    modelIds: options.modelIds,
    speed: options.speed,
    text: options.text,
  },
  "Generating TTS matrix across all model/voice combinations"
);

await ensureLocalSpeechModels({
  modelsDir: options.modelsDir,
  modelIds: options.modelIds,
  logger,
});

await mkdir(options.outputDir, { recursive: true });

const generated: GeneratedSample[] = [];

for (const modelId of options.modelIds) {
  const modelDir = getLocalSpeechModelDir(options.modelsDir, modelId);
  const modelOutputDir = path.join(options.outputDir, sanitizeFilePart(modelId));
  await mkdir(modelOutputDir, { recursive: true });

  if (modelId === "pocket-tts-onnx-int8") {
    const tts = await PocketTtsOnnxTTS.create(
      {
        modelDir,
        precision: "int8",
        targetChunkMs: 50,
      },
      logger
    );
    const result = await tts.synthesizeSpeech(options.text);
    const pcm16 = await readStreamToBuffer(result.stream);
    const sampleRate = parsePcmRateFromFormat(result.format, 24000) ?? 24000;

    const voiceLabel = "default";
    const filename = `${sanitizeFilePart(modelId)}__voice-${voiceLabel}.wav`;
    const absPath = path.join(modelOutputDir, filename);
    const relPath = path.relative(options.outputDir, absPath);

    await writeFile(absPath, pcm16MonoToWavBuffer(pcm16, sampleRate));

    generated.push({
      modelId,
      voiceLabel,
      speakerId: null,
      sampleRate,
      durationSeconds: pcm16.length / 2 / sampleRate,
      relativePath: relPath,
    });

    logger.info({ modelId, voiceLabel, path: relPath }, "Generated sample");
    continue;
  }

  if (modelId !== "kokoro-en-v0_19" && modelId !== "kitten-nano-en-v0_1-fp16") {
    throw new Error(`Unsupported local Sherpa TTS model for this script: ${modelId}`);
  }

  const { tts, speed } = createSherpaOfflineTts({
    modelId,
    modelDir,
    speed: options.speed,
  });

  try {
    const rawNumSpeakers = (tts as { numSpeakers?: unknown }).numSpeakers;
    const numSpeakers =
      typeof rawNumSpeakers === "number" && Number.isFinite(rawNumSpeakers) && rawNumSpeakers > 0
        ? Math.floor(rawNumSpeakers)
        : 1;
    const pad = Math.max(2, String(Math.max(0, numSpeakers - 1)).length);
    const fallbackSampleRate =
      typeof (tts as { sampleRate?: unknown }).sampleRate === "number"
        ? Math.max(1, Math.floor((tts as { sampleRate: number }).sampleRate))
        : 24000;

    logger.info({ modelId, numSpeakers }, "Discovered Sherpa speaker count");

    for (let sid = 0; sid < numSpeakers; sid += 1) {
      const audio = (tts as { generate: (config: { text: string; sid: number; speed: number }) => unknown }).generate({
        text: options.text,
        sid,
        speed,
      });
      const samples = toFloatSamples(audio);
      const sampleRate = toSampleRate(audio, fallbackSampleRate);
      const pcm16 = float32ToPcm16le(samples);

      const voiceLabel = `sid-${String(sid).padStart(pad, "0")}`;
      const filename = `${sanitizeFilePart(modelId)}__voice-${voiceLabel}.wav`;
      const absPath = path.join(modelOutputDir, filename);
      const relPath = path.relative(options.outputDir, absPath);

      await writeFile(absPath, pcm16MonoToWavBuffer(pcm16, sampleRate));

      generated.push({
        modelId,
        voiceLabel,
        speakerId: sid,
        sampleRate,
        durationSeconds: pcm16.length / 2 / sampleRate,
        relativePath: relPath,
      });

      logger.info({ modelId, voiceLabel, path: relPath }, "Generated sample");
    }
  } finally {
    (tts as { free?: () => void }).free?.();
  }
}

const manifest = {
  createdAt: new Date().toISOString(),
  text: options.text,
  speed: options.speed,
  modelsDir: options.modelsDir,
  outputDir: options.outputDir,
  namingConvention: "<model-id>/<model-id>__voice-<voice-label>.wav",
  notes: [
    "For Sherpa kitten/kokoro models, voice-label uses sid-<speaker-id>.",
    "For Pocket TTS, voice-label is default.",
  ],
  generated,
};

await writeFile(
  path.join(options.outputDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`
);
await writeFile(path.join(options.outputDir, "samples.csv"), toCsv(generated));
await writeFile(
  path.join(options.outputDir, "README.txt"),
  [
    "Sherpa TTS sample matrix",
    "",
    `Sample text: ${options.text}`,
    `Speed: ${options.speed}`,
    "",
    "Naming convention:",
    "  <model-id>/<model-id>__voice-<voice-label>.wav",
    "  voice-label = sid-<speaker-id> for Sherpa models",
    "  voice-label = default for Pocket TTS",
    "",
    `Total files: ${generated.length}`,
  ].join("\n")
);

logger.info(
  {
    outputDir: options.outputDir,
    generatedCount: generated.length,
    models: Array.from(new Set(generated.map((item) => item.modelId))),
  },
  "TTS matrix generation complete"
);
