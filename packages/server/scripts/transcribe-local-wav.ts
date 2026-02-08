import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { STTManager } from "../src/server/agent/stt-manager.js";
import { createRootLogger } from "../src/server/logger.js";
import { resolvePaseoHome } from "../src/server/paseo-home.js";
import {
  DEFAULT_LOCAL_STT_MODEL,
  DEFAULT_LOCAL_TTS_MODEL,
  LocalSttModelIdSchema,
  type LocalSttModelId,
} from "../src/server/speech/providers/local/models.js";
import { initializeLocalSpeechServices } from "../src/server/speech/providers/local/runtime.js";
import type { RequestedSpeechProviders } from "../src/server/speech/speech-types.js";

type CliOptions = {
  wavPath: string;
  outPath?: string;
  model: LocalSttModelId;
  modelsDir: string;
  autoDownload: boolean;
};

function usage(): string {
  return [
    "Usage: npm run speech:transcribe:local -- <wavPath> [--out <outPath>] [--model <modelId>] [--models-dir <dir>] [--no-auto-download]",
    "",
    "Examples:",
    "  npm run speech:transcribe:local -- ./sample.wav",
    "  npm run speech:transcribe:local -- ./sample.wav --out ./tmp/sample.transcript.txt",
    "",
    "Env fallbacks:",
    "  PASEO_LOCAL_MODELS_DIR, PASEO_LOCAL_STT_MODEL",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  if (argv.length === 0) {
    throw new Error(`Missing <wavPath>\n\n${usage()}`);
  }

  const paseoHome = resolvePaseoHome();
  const defaultModelsDir =
    process.env.PASEO_LOCAL_MODELS_DIR ?? path.join(paseoHome, "models", "local-speech");

  const positional: string[] = [];
  let outPath: string | undefined;
  let model = LocalSttModelIdSchema.parse(process.env.PASEO_LOCAL_STT_MODEL ?? DEFAULT_LOCAL_STT_MODEL);
  let modelsDir = defaultModelsDir;
  let autoDownload = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--out") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--out requires a value");
      }
      outPath = path.resolve(next);
      i += 1;
      continue;
    }

    if (arg === "--model") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--model requires a value");
      }
      model = LocalSttModelIdSchema.parse(next);
      i += 1;
      continue;
    }

    if (arg === "--models-dir") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--models-dir requires a value");
      }
      modelsDir = path.resolve(next);
      i += 1;
      continue;
    }

    if (arg === "--no-auto-download") {
      autoDownload = false;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    positional.push(arg);
  }

  if (positional.length === 0) {
    throw new Error(`Missing <wavPath>\n\n${usage()}`);
  }

  return {
    wavPath: path.resolve(positional[0]),
    ...(outPath ? { outPath } : {}),
    model,
    modelsDir,
    autoDownload,
  };
}

async function main(): Promise<void> {
  let options: CliOptions;

  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(2);
    return;
  }

  const logger = createRootLogger({ level: "info", format: "pretty" });

  const providers: RequestedSpeechProviders = {
    dictationStt: { provider: "local", explicit: true },
    voiceStt: { provider: "local", explicit: true },
    // Not used here, but required by the shared runtime config shape.
    voiceTts: { provider: "openai", explicit: false },
  };

  const runtime = await initializeLocalSpeechServices({
    providers,
    speechConfig: {
      providers,
      local: {
        modelsDir: options.modelsDir,
        autoDownload: options.autoDownload,
        models: {
          dictationStt: options.model,
          voiceStt: options.model,
          voiceTts: DEFAULT_LOCAL_TTS_MODEL,
        },
      },
    },
    logger,
  });

  try {
    if (!runtime.sttService) {
      throw new Error(
        "Local STT service is unavailable. Check model files or run `npm run speech:download -- --model " +
          options.model +
          "`."
      );
    }

    const audio = await readFile(options.wavPath);
    const manager = new STTManager("dev-local-wav-transcribe", logger, runtime.sttService);
    const result = await manager.transcribe(audio, "audio/wav", { label: "dev-local-wav-transcribe" });

    const transcript = result.text.trim();

    if (options.outPath) {
      await mkdir(path.dirname(options.outPath), { recursive: true });
      await writeFile(options.outPath, `${transcript}\n`, "utf8");
      logger.info({ outPath: options.outPath }, "Wrote transcript");
    }

    process.stdout.write(`${transcript}\n`);
  } finally {
    runtime.cleanup();
  }
}

await main();
