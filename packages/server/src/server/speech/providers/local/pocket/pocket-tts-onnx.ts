import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import type pino from "pino";

import type { SpeechStreamResult, TextToSpeechProvider } from "../../../speech-provider.js";
import {
  chunkBuffer,
  float32ToPcm16le,
  parsePcm16MonoWav,
  pcm16leToFloat32,
} from "../../../audio.js";
import { Pcm16MonoResampler } from "../../../../agent/pcm16-resampler.js";

type OrtModule = typeof import("onnxruntime-node");
type OrtSession = import("onnxruntime-node").InferenceSession;
type OrtTensor = import("onnxruntime-node").Tensor;

function createSessionFeed(feed: Record<string, OrtTensor>): Record<string, OrtTensor> {
  return feed;
}

interface SentencePieceProcessor {
  encodeIds: (text: string) => number[];
  load?: (modelPath: string) => unknown;
  Load?: (modelPath: string) => unknown;
}

function assertFileExists(filePath: string, label: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

function product(dims: number[]): number {
  let out = 1;
  for (const d of dims) out *= d;
  return out;
}

function normalizeDims(dims: Array<number | string | null | undefined>): number[] {
  // ONNX metadata can contain dynamic dimensions as strings (e.g. "batch") or -1.
  // For state tensors we want a valid minimal shape, so coerce unknown/invalid dims to 1.
  // Preserve explicit 0 dims (some models use empty initial state buffers with shape [0]).
  return dims.map((d) => {
    if (typeof d === "number" && Number.isFinite(d)) {
      if (d === 0) return 0;
      if (d > 0) return d;
      return 1;
    }
    return 1;
  });
}

function getSessionInputMeta(
  session: OrtSession,
  inputName: string,
): { type?: string; dims?: Array<number | string | null> } | undefined {
  const metaAny = session.inputMetadata;
  if (!Array.isArray(metaAny)) {
    return undefined;
  }
  const entry = metaAny.find((m) => m.name === inputName);
  if (!entry) return undefined;
  return { type: String(entry.type), dims: entry.shape };
}

function toBigInt64(values: number[]): BigInt64Array {
  const out = new BigInt64Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    out[i] = BigInt(values[i]);
  }
  return out;
}

function randn(): number {
  // Box–Muller
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function normalizeTextForPocket(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Cannot synthesize empty text");
  }
  let out = trimmed;
  if (out.length > 0 && /[A-Za-z0-9]$/.test(out)) {
    out = `${out}.`;
  }
  if (out.length > 0 && /[a-z]/.test(out[0])) {
    out = out[0].toUpperCase() + out.slice(1);
  }
  return out;
}

async function loadOrt(): Promise<OrtModule> {
  return import("onnxruntime-node");
}

interface SentencePieceModule {
  SentencePieceProcessor?: new () => SentencePieceProcessor;
  default?:
    | (new () => SentencePieceProcessor)
    | { SentencePieceProcessor?: new () => SentencePieceProcessor };
}

function isSentencePieceModule(mod: unknown): mod is SentencePieceModule {
  return mod !== null && typeof mod === "object";
}

function getSentencePieceProcessor(
  mod: SentencePieceModule,
): (new () => SentencePieceProcessor) | undefined {
  if (mod.SentencePieceProcessor) {
    return mod.SentencePieceProcessor;
  }
  const defaultValue = mod.default;
  if (
    defaultValue &&
    typeof defaultValue === "object" &&
    "SentencePieceProcessor" in defaultValue
  ) {
    return defaultValue.SentencePieceProcessor;
  }
  if (typeof defaultValue === "function") {
    return defaultValue as new () => SentencePieceProcessor;
  }
  return undefined;
}

async function loadSentencePiece(tokenizerModelPath: string): Promise<SentencePieceProcessor> {
  const mod = await import("@sctg/sentencepiece-js");

  if (!isSentencePieceModule(mod)) {
    throw new Error("@sctg/sentencepiece-js module has unexpected shape");
  }

  const Processor = getSentencePieceProcessor(mod);

  if (!Processor) {
    throw new Error("Failed to load SentencePiece processor from @sctg/sentencepiece-js");
  }

  const sp = new Processor();

  if (typeof sp.load === "function") {
    await sp.load(tokenizerModelPath);
  } else if (typeof sp.Load === "function") {
    sp.Load(tokenizerModelPath);
  } else {
    throw new Error("SentencePiece processor does not expose load()/Load()");
  }

  return sp;
}

function getOrtProviders(ort: OrtModule, device: "auto" | "cpu" | "cuda"): string[] {
  // NOTE: onnxruntime-node uses backend names like "cpu"/"coreml"/"webgpu" (not "CPUExecutionProvider").
  if (device === "cpu") return ["cpu"];
  if (device === "cuda") return ["cuda", "cpu"];
  // auto
  // CoreML EP does not support some dynamic/zero-length shapes used by Pocket TTS (e.g. [1, 0, 32]).
  // Default to CPU to keep behavior predictable across platforms.
  void ort;
  return ["cpu"];
}

function createZeroTensorForInput(
  ort: OrtModule,
  session: OrtSession,
  inputName: string,
): OrtTensor {
  const meta = getSessionInputMeta(session, inputName);
  const dims = normalizeDims(meta?.dims ?? []);
  if (dims.length === 0) {
    throw new Error(`Missing input metadata shape for ${inputName}`);
  }

  const type = (meta?.type ?? "float32").toLowerCase();
  const size = product(dims);

  if (type.includes("int64")) {
    return new ort.Tensor("int64", new BigInt64Array(size), dims);
  }
  if (type.includes("bool")) {
    return new ort.Tensor("bool", new Uint8Array(size), dims);
  }
  return new ort.Tensor("float32", new Float32Array(size), dims);
}

function initState(session: OrtSession, ort: OrtModule): Record<string, OrtTensor> {
  const out: Record<string, OrtTensor> = {};
  for (const name of session.inputNames) {
    if (name.startsWith("state_")) {
      out[name] = createZeroTensorForInput(ort, session, name);
    }
  }
  return out;
}

function updateStateFromOutputs(
  state: Record<string, OrtTensor>,
  outputs: Record<string, OrtTensor>,
): void {
  for (const [name, tensor] of Object.entries(outputs)) {
    if (!name.startsWith("out_state_")) continue;
    const idx = Number.parseInt(name.replace("out_state_", ""), 10);
    if (Number.isFinite(idx)) {
      state[`state_${idx}`] = tensor;
    }
  }
}

interface OrtTensorWithData {
  data: unknown;
}

function tensorDataFloat32(t: OrtTensor): Float32Array {
  const tensorWithData = t as OrtTensorWithData;
  const data = tensorWithData.data;
  if (data instanceof Float32Array) return data;
  if (Array.isArray(data)) return Float32Array.from(data);
  throw new Error("Unexpected tensor data type (expected Float32Array)");
}

export interface PocketTtsOnnxConfig {
  modelDir: string;
  precision?: "int8" | "fp32";
  device?: "auto" | "cpu" | "cuda";
  temperature?: number;
  lsdSteps?: number;
  maxFrames?: number;
  framesAfterEos?: number;
  firstChunkFrames?: number;
  maxChunkFrames?: number;
  targetChunkMs?: number;
  referenceAudioFile?: string;
}

class PocketTtsOnnxEngine {
  static readonly SAMPLE_RATE = 24000;
  static readonly SAMPLES_PER_FRAME = 1920;

  private readonly ort: OrtModule;

  private readonly temperature: number;
  private readonly lsdSteps: number;
  private readonly maxFrames: number;
  private readonly framesAfterEos: number;

  private readonly firstChunkFrames: number;
  private readonly maxChunkFrames: number;

  private readonly tokenizer: SentencePieceProcessor;
  private readonly textConditioner: OrtSession;
  private readonly flowLmMain: OrtSession;
  private readonly flowLmFlow: OrtSession;
  private readonly mimiDecoder: OrtSession;

  private readonly stBuffers: Array<{ s: OrtTensor; t: OrtTensor }>;
  private readonly voiceEmbeddings: OrtTensor;

  private constructor(args: {
    ort: OrtModule;
    temperature: number;
    lsdSteps: number;
    maxFrames: number;
    framesAfterEos: number;
    firstChunkFrames: number;
    maxChunkFrames: number;
    tokenizer: SentencePieceProcessor;
    textConditioner: OrtSession;
    flowLmMain: OrtSession;
    flowLmFlow: OrtSession;
    mimiDecoder: OrtSession;
    stBuffers: Array<{ s: OrtTensor; t: OrtTensor }>;
    voiceEmbeddings: OrtTensor;
  }) {
    this.ort = args.ort;
    this.temperature = args.temperature;
    this.lsdSteps = args.lsdSteps;
    this.maxFrames = args.maxFrames;
    this.framesAfterEos = args.framesAfterEos;
    this.firstChunkFrames = args.firstChunkFrames;
    this.maxChunkFrames = args.maxChunkFrames;
    this.tokenizer = args.tokenizer;
    this.textConditioner = args.textConditioner;
    this.flowLmMain = args.flowLmMain;
    this.flowLmFlow = args.flowLmFlow;
    this.mimiDecoder = args.mimiDecoder;
    this.stBuffers = args.stBuffers;
    this.voiceEmbeddings = args.voiceEmbeddings;
  }

  static async create(
    config: PocketTtsOnnxConfig,
    logger: pino.Logger,
  ): Promise<PocketTtsOnnxEngine> {
    const log = logger.child({
      module: "speech",
      provider: "pocket-tts",
      component: "onnx-engine",
    });

    const modelDir = config.modelDir;
    const onnxDir = `${modelDir}/onnx`;
    const precision = config.precision ?? "int8";
    const device = config.device ?? "auto";
    const temperature = config.temperature ?? 0.7;
    const lsdSteps = config.lsdSteps ?? 10;
    const maxFrames = config.maxFrames ?? 500;
    const framesAfterEos = config.framesAfterEos ?? 3;
    const firstChunkFrames = config.firstChunkFrames ?? 2;
    const maxChunkFrames = config.maxChunkFrames ?? 15;

    const tokenizerPath = `${modelDir}/tokenizer.model`;
    const referenceAudioFile = config.referenceAudioFile ?? `${modelDir}/reference_sample.wav`;

    const flowMainFile = precision === "int8" ? "flow_lm_main_int8.onnx" : "flow_lm_main.onnx";
    const flowFlowFile = precision === "int8" ? "flow_lm_flow_int8.onnx" : "flow_lm_flow.onnx";
    const decoderFile = precision === "int8" ? "mimi_decoder_int8.onnx" : "mimi_decoder.onnx";

    assertFileExists(`${onnxDir}/mimi_encoder.onnx`, "PocketTTS mimi_encoder");
    assertFileExists(`${onnxDir}/text_conditioner.onnx`, "PocketTTS text_conditioner");
    assertFileExists(`${onnxDir}/${flowMainFile}`, "PocketTTS flow_lm_main");
    assertFileExists(`${onnxDir}/${flowFlowFile}`, "PocketTTS flow_lm_flow");
    assertFileExists(`${onnxDir}/${decoderFile}`, "PocketTTS mimi_decoder");
    assertFileExists(tokenizerPath, "PocketTTS tokenizer.model");
    assertFileExists(referenceAudioFile, "PocketTTS reference_sample.wav");

    const ort = await loadOrt();
    const providers = getOrtProviders(ort, device);

    const [tokenizer, mimiEncoder, textConditioner, flowLmMain, flowLmFlow, mimiDecoder] =
      await Promise.all([
        loadSentencePiece(tokenizerPath),
        ort.InferenceSession.create(`${onnxDir}/mimi_encoder.onnx`, {
          executionProviders: providers,
        }),
        ort.InferenceSession.create(`${onnxDir}/text_conditioner.onnx`, {
          executionProviders: providers,
        }),
        ort.InferenceSession.create(`${onnxDir}/${flowMainFile}`, {
          executionProviders: providers,
        }),
        ort.InferenceSession.create(`${onnxDir}/${flowFlowFile}`, {
          executionProviders: providers,
        }),
        ort.InferenceSession.create(`${onnxDir}/${decoderFile}`, { executionProviders: providers }),
      ]);

    // Precompute flow matching time-step buffers.
    const stBuffers: Array<{ s: OrtTensor; t: OrtTensor }> = [];
    for (let j = 0; j < lsdSteps; j += 1) {
      const s = j / lsdSteps;
      const t = s + 1.0 / lsdSteps;
      stBuffers.push({
        s: new ort.Tensor("float32", new Float32Array([s]), [1, 1]),
        t: new ort.Tensor("float32", new Float32Array([t]), [1, 1]),
      });
    }

    // Precompute reference voice embeddings once.
    const refWav = await readFile(referenceAudioFile);
    const parsed = parsePcm16MonoWav(refWav);
    let pcm16 = parsed.pcm16;
    if (parsed.sampleRate !== PocketTtsOnnxEngine.SAMPLE_RATE) {
      const resampler = new Pcm16MonoResampler({
        inputRate: parsed.sampleRate,
        outputRate: PocketTtsOnnxEngine.SAMPLE_RATE,
      });
      pcm16 = resampler.processChunk(pcm16);
    }
    const floatAudio = pcm16leToFloat32(pcm16);
    const audioTensor = new ort.Tensor("float32", floatAudio, [1, 1, floatAudio.length]);

    const encoded = await mimiEncoder.run({ audio: audioTensor });
    const firstOutName = mimiEncoder.outputNames?.[0];
    const encodedRecord = encoded as Record<string, OrtTensor>;
    const voiceEmb = firstOutName ? encodedRecord[firstOutName] : Object.values(encodedRecord)[0];
    if (!voiceEmb) {
      throw new Error("PocketTTS mimi_encoder: missing output");
    }

    log.info({ precision, device, providers, lsdSteps, temperature }, "PocketTTS ONNX initialized");

    return new PocketTtsOnnxEngine({
      ort,
      temperature,
      lsdSteps,
      maxFrames,
      framesAfterEos,
      firstChunkFrames,
      maxChunkFrames,
      tokenizer,
      textConditioner,
      flowLmMain,
      flowLmFlow,
      mimiDecoder,
      stBuffers,
      voiceEmbeddings: voiceEmb,
    });
  }

  private tokenize(text: string): OrtTensor {
    const normalized = normalizeTextForPocket(text);
    const ids = this.tokenizer.encodeIds(normalized);
    const data = toBigInt64(ids ?? []);
    return new this.ort.Tensor("int64", data, [1, data.length]);
  }

  private async runTextConditioner(tokenIds: OrtTensor): Promise<OrtTensor> {
    const feed: Record<string, OrtTensor> = { token_ids: tokenIds };
    const out = await this.textConditioner.run(feed);
    const firstOutName = this.textConditioner.outputNames?.[0];
    const outRecord = out as Record<string, OrtTensor>;
    const t = firstOutName ? outRecord[firstOutName] : Object.values(outRecord)[0];
    if (!t) throw new Error("PocketTTS text_conditioner: missing output");
    return t;
  }

  private async *runFlowLm(textEmbeddings: OrtTensor): AsyncGenerator<Float32Array> {
    const ort = this.ort;
    const state = initState(this.flowLmMain, ort);

    const emptySeq = new ort.Tensor("float32", new Float32Array(0), [1, 0, 32]);
    const emptyText = new ort.Tensor("float32", new Float32Array(0), [1, 0, 1024]);

    // Voice conditioning pass
    const resVoice = await this.flowLmMain.run(
      createSessionFeed({
        sequence: emptySeq,
        text_embeddings: this.voiceEmbeddings,
        ...state,
      }),
    );
    updateStateFromOutputs(state, resVoice as Record<string, OrtTensor>);

    // Text conditioning pass
    const resText = await this.flowLmMain.run(
      createSessionFeed({
        sequence: emptySeq,
        text_embeddings: textEmbeddings,
        ...state,
      }),
    );
    updateStateFromOutputs(state, resText as Record<string, OrtTensor>);

    // Autoregressive generation
    const curr = new Float32Array(32);
    curr.fill(Number.NaN);
    let currTensor = new ort.Tensor("float32", curr, [1, 1, 32]);

    const dt = 1.0 / this.lsdSteps;
    let eosStep: number | null = null;

    for (let step = 0; step < this.maxFrames; step += 1) {
      const resStep = await this.flowLmMain.run(
        createSessionFeed({
          sequence: currTensor,
          text_embeddings: emptyText,
          ...state,
        }),
      );

      const outputNames = this.flowLmMain.outputNames;
      const resStepRecord = resStep as Record<string, OrtTensor>;
      const conditioningName = outputNames?.[0] ?? Object.keys(resStepRecord)[0];
      const eosName = outputNames?.[1] ?? Object.keys(resStepRecord)[1];

      const conditioning = resStepRecord[conditioningName];
      const eos = resStepRecord[eosName];
      if (!conditioning || !eos) {
        throw new Error("PocketTTS flow_lm_main: missing conditioning/EOS outputs");
      }
      updateStateFromOutputs(state, resStepRecord);

      const eosData = tensorDataFloat32(eos);
      if (eosData[0] > -4.0 && eosStep === null) {
        eosStep = step;
      }
      if (eosStep !== null && step >= eosStep + this.framesAfterEos) {
        break;
      }

      // Flow matching with external Euler loop.
      const std = this.temperature > 0 ? Math.sqrt(this.temperature) : 0;
      const x = new Float32Array(32);
      if (std > 0) {
        for (let i = 0; i < x.length; i += 1) {
          x[i] = randn() * std;
        }
      }

      for (const st of this.stBuffers) {
        const xTensor = new ort.Tensor("float32", x, [1, 32]);
        const flowOut = await this.flowLmFlow.run(
          createSessionFeed({
            c: conditioning,
            s: st.s,
            t: st.t,
            x: xTensor,
          }),
        );
        const first = this.flowLmFlow.outputNames?.[0];
        const flowOutRecord = flowOut as Record<string, OrtTensor>;
        const flowTensor = first ? flowOutRecord[first] : Object.values(flowOutRecord)[0];
        if (!flowTensor) throw new Error("PocketTTS flow_lm_flow: missing output");
        const delta = tensorDataFloat32(flowTensor);
        for (let i = 0; i < x.length; i += 1) {
          x[i] = x[i] + delta[i] * dt;
        }
      }

      yield x;
      currTensor = new ort.Tensor("float32", x, [1, 1, 32]);
    }
  }

  private async decodeLatentsChunk(
    frames: Float32Array[],
    state: Record<string, OrtTensor>,
  ): Promise<Float32Array> {
    const ort = this.ort;
    const frameCount = frames.length;
    const flattened = new Float32Array(frameCount * 32);
    for (let i = 0; i < frameCount; i += 1) {
      flattened.set(frames[i], i * 32);
    }
    const latent = new ort.Tensor("float32", flattened, [1, frameCount, 32]);

    const out = await this.mimiDecoder.run(createSessionFeed({ latent, ...state }));
    const outRecord = out as Record<string, OrtTensor>;
    updateStateFromOutputs(state, outRecord);

    const firstOutName = this.mimiDecoder.outputNames?.[0];
    const audioTensor = firstOutName ? outRecord[firstOutName] : Object.values(outRecord)[0];
    if (!audioTensor) {
      throw new Error("PocketTTS mimi_decoder: missing audio output");
    }
    return tensorDataFloat32(audioTensor);
  }

  async *streamAudio(text: string): AsyncGenerator<Float32Array> {
    const tokenIds = this.tokenize(text);
    const textEmb = await this.runTextConditioner(tokenIds);

    const decoderState = initState(this.mimiDecoder, this.ort);

    const generated: Float32Array[] = [];
    let decodedFrames = 0;

    for await (const latent of this.runFlowLm(textEmb)) {
      generated.push(latent);
      const pending = generated.length - decodedFrames;

      let chunkSize = 0;
      if (decodedFrames === 0) {
        if (pending >= this.firstChunkFrames) {
          chunkSize = this.firstChunkFrames;
        }
      } else if (pending >= this.maxChunkFrames) {
        chunkSize = this.maxChunkFrames;
      }

      if (chunkSize > 0) {
        const audio = await this.decodeLatentsChunk(
          generated.slice(decodedFrames, decodedFrames + chunkSize),
          decoderState,
        );
        decodedFrames += chunkSize;
        yield audio;
      }
    }

    if (decodedFrames < generated.length) {
      const audio = await this.decodeLatentsChunk(generated.slice(decodedFrames), decoderState);
      yield audio;
    }
  }
}

export class PocketTtsOnnxTTS implements TextToSpeechProvider {
  private readonly engine: PocketTtsOnnxEngine;
  private readonly chunkMs: number;
  private readonly logger: pino.Logger;

  private constructor(engine: PocketTtsOnnxEngine, logger: pino.Logger, chunkMs: number) {
    this.engine = engine;
    this.chunkMs = chunkMs;
    this.logger = logger.child({ module: "speech", provider: "pocket-tts", component: "tts" });
  }

  static async create(config: PocketTtsOnnxConfig, logger: pino.Logger): Promise<PocketTtsOnnxTTS> {
    const engine = await PocketTtsOnnxEngine.create(config, logger);
    const chunkMs = config.targetChunkMs ?? 50;
    return new PocketTtsOnnxTTS(engine, logger, chunkMs);
  }

  async synthesizeSpeech(text: string): Promise<SpeechStreamResult> {
    const start = Date.now();
    const sampleRate = PocketTtsOnnxEngine.SAMPLE_RATE;

    const pcmChunkBytes = Math.max(2, Math.round((sampleRate * this.chunkMs) / 1000) * 2);

    const iterable = (async function* (engine: PocketTtsOnnxEngine) {
      for await (const floatChunk of engine.streamAudio(text)) {
        const pcm = float32ToPcm16le(floatChunk);
        for (const chunk of chunkBuffer(pcm, pcmChunkBytes)) {
          yield chunk;
        }
      }
    })(this.engine);

    this.logger.debug(
      { ms: Date.now() - start, textLength: text.length },
      "PocketTTS stream ready",
    );

    return {
      stream: Readable.from(iterable),
      format: `pcm;rate=${sampleRate}`,
    };
  }
}
