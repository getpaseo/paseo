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

// Batch size when calling the underlying transformers.js pipeline. The model
// allocates Float32Array tensors proportional to (batch * seq_len * dim);
// large callers that pass thousands of strings in one go cause spikes that
// the kernel OOM-kills (taking the whole daemon with them — there's no
// process boundary). Empirically 8 is small enough that the per-batch
// allocation is reclaimed reliably between yields even on big repos;
// 32 was leaving residual tensors retained by the extractor's internal
// caches and growing RSS monotonically. Tunable via HUBCODE_LOCAL_BATCH_SIZE.
const PIPELINE_BATCH_SIZE = (() => {
  const env = Number.parseInt(process.env.HUBCODE_LOCAL_BATCH_SIZE ?? "", 10);
  return Number.isFinite(env) && env > 0 ? env : 8;
})();

// Sleep between batches. `setImmediate` only yields one macrotask which is
// not enough — V8's incremental marker needs actual idle ticks to reclaim
// the activation tensors before the next batch allocates more. A small
// real sleep (3ms here) gives the GC a window without meaningfully slowing
// the run (1000 batches × 3ms = 3s overhead).
const BATCH_YIELD_MS = (() => {
  const env = Number.parseInt(process.env.HUBCODE_LOCAL_BATCH_YIELD_MS ?? "", 10);
  return Number.isFinite(env) && env >= 0 ? env : 3;
})();

// Force a synchronous GC every N batches when --expose-gc is enabled
// (`node --expose-gc`). When the flag isn't set, `global.gc` is undefined
// and we silently skip — no behavior change. With the flag, this is the
// most reliable way to keep RSS flat across thousands of batches.
const GC_EVERY_N_BATCHES = (() => {
  const env = Number.parseInt(process.env.HUBCODE_LOCAL_GC_EVERY ?? "", 10);
  return Number.isFinite(env) && env > 0 ? env : 50;
})();

// Hard ceiling on inputs per single inference call. Even with chunking,
// thousands of items in one call keep the synchronous JS loop running for
// minutes — the daemon's event loop is starved, RSS-monitor polls don't
// fire, and the kernel OOM-kills the daemon before any defensive code can
// abort. Reject the call upfront with a clear message instead. Tunable via
// HUBCODE_LOCAL_INFER_MAX_INPUTS. Default 5000 (well under what triggers
// OOM in our reproductions while still serving most repos).
const MAX_INPUTS_PER_CALL = (() => {
  const env = Number.parseInt(process.env.HUBCODE_LOCAL_INFER_MAX_INPUTS ?? "", 10);
  return Number.isFinite(env) && env > 0 ? env : 5000;
})();

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
    const items = Array.isArray(input) ? input : [input];
    if (items.length > MAX_INPUTS_PER_CALL) {
      throw new Error(
        `Hubcode Local embedding rejected: ${items.length} inputs in a single call exceeds the safety limit of ${MAX_INPUTS_PER_CALL}. The local embedder runs in the daemon process and cannot survive batches this large without crashing the daemon. Switch to a remote embedding provider (OpenAI, Voyage, etc.) for repositories of this size, or raise the limit via HUBCODE_LOCAL_INFER_MAX_INPUTS at your own risk.`,
      );
    }
    const fn = await ensurePipeline();
    // Chunk the input so a single huge batch can't allocate enough tensor
    // memory at once to OOM-kill the daemon. We yield to the event loop
    // between chunks so V8 can reclaim activations from the previous batch
    // and force GC every N batches when --expose-gc is available.
    const exposedGc =
      typeof (globalThis as { gc?: () => void }).gc === "function"
        ? (globalThis as { gc?: () => void }).gc
        : null;
    const vectors: number[][] = [];
    let batchIndex = 0;
    for (let offset = 0; offset < items.length; offset += PIPELINE_BATCH_SIZE) {
      const chunk = items.slice(offset, offset + PIPELINE_BATCH_SIZE);
      const chunkVectors = await fn(chunk);
      vectors.push(...chunkVectors);
      batchIndex += 1;
      // Real sleep (not setImmediate) so V8's incremental marker actually
      // gets idle ticks to reclaim activation tensors.
      if (BATCH_YIELD_MS > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, BATCH_YIELD_MS));
      }
      // Periodic forced GC to prevent the extractor's internal tensor
      // caches from growing monotonically across thousands of batches.
      // Only fires when daemon was started with --expose-gc.
      if (exposedGc && batchIndex % GC_EVERY_N_BATCHES === 0) {
        exposedGc();
      }
    }
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
