import { resolveJunctionHome } from "../src/server/junction-home.js";
import { createRootLogger } from "../src/server/logger.js";
import {
  DEFAULT_LOCAL_STT_MODEL,
  DEFAULT_LOCAL_TTS_MODEL,
  ensureLocalSpeechModels,
  type LocalSpeechModelId,
} from "../src/server/speech/providers/local/models.js";

function parseArgs(argv: string[]): { modelsDir: string; modelIds: LocalSpeechModelId[] } {
  const home = resolveJunctionHome();
  let modelsDir = process.env.JUNCTION_LOCAL_MODELS_DIR || `${home}/models/local-speech`;
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
    const stt = (process.env.JUNCTION_LOCAL_STT_MODEL || DEFAULT_LOCAL_STT_MODEL) as LocalSpeechModelId;
    const tts = (process.env.JUNCTION_LOCAL_TTS_MODEL || DEFAULT_LOCAL_TTS_MODEL) as LocalSpeechModelId;
    modelIds.push(stt, tts);
  }

  return { modelsDir, modelIds };
}

const logger = createRootLogger({ level: "info", format: "pretty" });

const { modelsDir, modelIds } = parseArgs(process.argv.slice(2));
await ensureLocalSpeechModels({ modelsDir, modelIds, logger });
logger.info({ modelsDir, modelIds }, "Done downloading speech models");
