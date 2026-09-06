import { resolvePaseoHome } from "../src/server/paseo-home.js";
import { createRootLogger } from "../src/server/logger.js";
import {
  DEFAULT_LOCAL_STT_MODEL,
  DEFAULT_LOCAL_TTS_MODEL,
  ensureLocalSpeechModels,
  type LocalSpeechModelId,
} from "../src/server/speech/providers/local/models.js";

function usage(): string {
  return [
    "Usage: npm run speech:download -- [--models-dir <dir>] [--model <modelId>]",
    "",
    "Examples:",
    "  npm run speech:download -- --model parakeet-tdt-0.6b-v2-int8",
    "  npm run speech:download -- --model sense-voice-zh-en-ja-ko-yue-int8-2025-09-09",
    "  npm run speech:download -- --models-dir /tmp/paseo-speech --model sense-voice-zh-en-ja-ko-yue-int8-2025-09-09",
  ].join("\n");
}

function parseArgs(argv: string[]): { modelsDir: string; modelIds: LocalSpeechModelId[] } {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const home = resolvePaseoHome();
  let modelsDir = process.env.PASEO_LOCAL_MODELS_DIR || `${home}/models/local-speech`;
  const modelIds: LocalSpeechModelId[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--models-dir") {
      modelsDir = argv[i + 1] ?? modelsDir;
      i++;
      continue;
    }
    if (arg === "--model") {
      const id = argv[i + 1] as LocalSpeechModelId | undefined;
      if (!id) {
        throw new Error("--model requires a value");
      }
      modelIds.push(id);
      i++;
      continue;
    }
  }

  if (modelIds.length === 0) {
    modelIds.push(DEFAULT_LOCAL_STT_MODEL, DEFAULT_LOCAL_TTS_MODEL);
  }

  return { modelsDir, modelIds };
}

const logger = createRootLogger({ level: "info", format: "pretty" });

const { modelsDir, modelIds } = parseArgs(process.argv.slice(2));
await ensureLocalSpeechModels({ modelsDir, modelIds, logger });
logger.info({ modelsDir, modelIds }, "Done downloading speech models");
