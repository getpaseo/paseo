import type { Logger } from "pino";
import type { EmbeddingInferenceFn } from "./embedding-server.js";

/**
 * Hubcode Local inference engine, backed by `@xenova/transformers`.
 *
 * Default model: `Xenova/bge-small-en-v1.5` (384-dim, ~130MB, SOTA at this
 * size on MTEB). The transformers.js pipeline downloads the ONNX bundle
 * + tokenizer.json on first call and caches under `~/.cache/huggingface`.
 *
 * Pipeline-level abstraction (vs. raw `onnxruntime-node` + manual
 * tokenization) is a deliberate trade: we accept ~30MB of bundled deps to
 * get a battle-tested WordPiece tokenizer + correct mean-pooling and
 * normalization. Hand-rolled BERT tokenization is notorious for silent
 * embedding corruption (off-by-one in special tokens, wrong vocab merges)
 * that only surfaces as poor search quality much later.
 *
 * Lazy: the pipeline is loaded on the first `infer()` call so daemon boot
 * doesn't pay the model download cost when the user hasn't selected
 * Hubcode Local.
 */

export const DEFAULT_HUBCODE_LOCAL_MODEL = "Xenova/bge-small-en-v1.5";

export interface HubcodeLocalInferenceDeps {
  logger: Logger;
  /** Override default model — must be a transformers.js-compatible feature-extraction model. */
  modelId?: string;
  /**
   * Inject for tests; default uses the real `@xenova/transformers` pipeline.
   * Returns a function that produces (mean-pooled, L2-normalized) vectors.
   */
  pipelineFactory?: () => Promise<(text: string | string[]) => Promise<number[][]>>;
}

export function createHubcodeLocalInference(deps: HubcodeLocalInferenceDeps): EmbeddingInferenceFn {
  const logger = deps.logger.child({ module: "hubcode-local-inference" });
  const modelId = deps.modelId ?? DEFAULT_HUBCODE_LOCAL_MODEL;
  let pipelinePromise: Promise<(text: string | string[]) => Promise<number[][]>> | null = null;

  const ensurePipeline = (): Promise<(text: string | string[]) => Promise<number[][]>> => {
    if (pipelinePromise) return pipelinePromise;
    pipelinePromise = (deps.pipelineFactory ?? defaultPipelineFactory(modelId, logger))();
    return pipelinePromise;
  };

  return async (input, hints) => {
    const fn = await ensurePipeline();
    const vectors = await fn(input);
    const dimension = vectors[0]?.length ?? 0;
    if (hints?.dimensions != null && hints.dimensions !== dimension) {
      logger.debug(
        { requested: hints.dimensions, actual: dimension },
        "Caller requested dimension reduction but the local provider does not support it; returning native dim",
      );
    }
    return {
      vectors,
      model: hints?.model ?? modelId,
      dimension,
    };
  };
}

function defaultPipelineFactory(
  modelId: string,
  logger: Logger,
): () => Promise<(text: string | string[]) => Promise<number[][]>> {
  return async () => {
    logger.info({ modelId }, "Loading Hubcode Local embedding pipeline (first-call download)");
    // Lazy import so transformers.js' bundle isn't paid until needed.
    const { pipeline } = (await import("@xenova/transformers")) as unknown as {
      pipeline: (
        task: string,
        model: string,
      ) => Promise<
        (
          text: string | string[],
          opts?: { pooling?: string; normalize?: boolean },
        ) => Promise<{
          data: Float32Array;
          dims: number[];
        }>
      >;
    };
    const extractor = await pipeline("feature-extraction", modelId);
    return async (text) => {
      const inputs = Array.isArray(text) ? text : [text];
      const out = await extractor(inputs, { pooling: "mean", normalize: true });
      // out.data is a flat Float32Array of shape [batch, dim].
      const [batch, dim] = out.dims;
      if (batch == null || dim == null) {
        throw new Error("Unexpected feature-extraction output shape");
      }
      const vectors: number[][] = [];
      for (let i = 0; i < batch; i += 1) {
        const slice = out.data.subarray(i * dim, (i + 1) * dim);
        vectors.push(Array.from(slice));
      }
      return vectors;
    };
  };
}
