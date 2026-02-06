import { resolvePaseoHome } from "../src/server/paseo-home.js";
import { createRootLogger } from "../src/server/logger.js";
import { ensureSherpaOnnxModels } from "../src/server/speech/sherpa/model-downloader.js";
import type { SherpaOnnxModelId } from "../src/server/speech/sherpa/model-catalog.js";

function parseArgs(argv: string[]): { modelsDir: string; modelIds: SherpaOnnxModelId[] } {
  const home = resolvePaseoHome();
  let modelsDir = process.env.PASEO_SHERPA_ONNX_MODELS_DIR || `${home}/models/sherpa-onnx`;
  const modelIds: SherpaOnnxModelId[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--models-dir") {
      modelsDir = argv[i + 1] ?? modelsDir;
      i++;
      continue;
    }
    if (arg === "--model") {
      const id = argv[i + 1] as SherpaOnnxModelId | undefined;
      if (!id) {
        throw new Error("--model requires a value");
      }
      modelIds.push(id);
      i++;
      continue;
    }
  }

  if (modelIds.length === 0) {
    const stt = (process.env.PASEO_SHERPA_STT_PRESET || "zipformer-bilingual-zh-en-2023-02-20") as SherpaOnnxModelId;
    const tts = (process.env.PASEO_SHERPA_TTS_PRESET || "pocket-tts-onnx-int8") as SherpaOnnxModelId;
    modelIds.push(stt, tts);
  }

  return { modelsDir, modelIds };
}

const logger = createRootLogger({ level: "info", format: "pretty" });

const { modelsDir, modelIds } = parseArgs(process.argv.slice(2));
await ensureSherpaOnnxModels({ modelsDir, modelIds, autoDownload: true, logger });
logger.info({ modelsDir, modelIds }, "Done downloading speech models");
