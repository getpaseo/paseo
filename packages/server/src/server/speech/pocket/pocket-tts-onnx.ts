import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import type pino from "pino";

import type { SpeechStreamResult, TextToSpeechProvider } from "../speech-provider.js";
import { chunkBuffer, float32ToPcm16le, parsePcm16MonoWav, pcm16leToFloat32 } from "../audio.js";
import { Pcm16MonoResampler } from "../../agent/pcm16-resampler.js";

type OrtModule = typeof import("onnxruntime-node");
type OrtSession = import("onnxruntime-node").InferenceSession;
type OrtTensor = import("onnxruntime-node").Tensor;

type SentencePieceProcessor = {
  encodeIds: (text: string) => number[];
  load?: (modelPath: string) => unknown;
  Load?: (modelPath: string) => unknown;
};

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
  inputName: string
): { type?: string; dims?: Array<number | string | null> } | undefined {
  const metaAny = (session as any).inputMetadata as unknown;
  if (Array.isArray(metaAny)) {
    const entry = metaAny.find((m) => m && typeof m === "object" && (m as any).name === inputName) as any;
    if (!entry) return undefined;
    return { type: entry.type, dims: entry.shape };
  }

  if (metaAny && typeof metaAny === "object" && inputName in (metaAny as any)) {
    const entry = (metaAny as any)[inputName] as any;
    return { type: entry?.type, dims: entry?.dimensions ?? entry?.shape };
  }

  return undefined;
}

function toBigInt64(values: number[]): BigInt64Array {
  const out = new BigInt64Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    out[i] = BigInt(values[i]!);
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
  if (out.length > 0 && /[a-z]/.test(out[0]!)) {
    out = out[0]!.toUpperCase() + out.slice(1);
  }
  return out;
}

async function loadOrt(): Promise<OrtModule> {
  return (await import("onnxruntime-node")) as OrtModule;
}

async function loadSentencePiece(tokenizerModelPath: string): Promise<SentencePieceProcessor> {
  const mod = await import("@sctg/sentencepiece-js");

  const Processor =
    (mod as any).SentencePieceProcessor ??
    (mod as any).default?.SentencePieceProcessor ??
    (mod as any).default;

  if (!Processor) {
    throw new Error("Failed to load SentencePiece processor from @sctg/sentencepiece-js");
  }

  const sp: SentencePieceProcessor = new Processor();

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

function createZeroTensorForInput(ort: OrtModule, session: OrtSession, inputName: string): OrtTensor {
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
  for (const name of (session as any).inputNames as string[]) {
    if (name.startsWith("state_")) {
      out[name] = createZeroTensorForInput(ort, session, name);
    }
  }
  return out;
}

function updateStateFromOutputs(
  state: Record<string, OrtTensor>,
  outputs: Record<string, OrtTensor>
): void {
  for (const [name, tensor] of Object.entries(outputs)) {
    if (!name.startsWith("out_state_")) continue;
    const idx = Number.parseInt(name.replace("out_state_", ""), 10);
    if (Number.isFinite(idx)) {
      state[`state_${idx}`] = tensor;
    }
  }
}

function tensorDataFloat32(t: OrtTensor): Float32Array {
  const data = (t as any).data;
  if (data instanceof Float32Array) return data;
  if (Array.isArray(data)) return Float32Array.from(data as number[]);
  throw new Error("Unexpected tensor data type (expected Float32Array)");
}

export type PocketTtsOnnxConfig = {
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
};

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

  static async create(config: PocketTtsOnnxConfig, logger: pino.Logger): Promise<PocketTtsOnnxEngine> {
    const log = logger.child({ module: "speech", provider: "pocket-tts", component: "onnx-engine" });

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

    const [tokenizer, mimiEncoder, textConditioner, flowLmMain, flowLmFlow, mimiDecoder] = await Promise.all([
      loadSentencePiece(tokenizerPath),
      ort.InferenceSession.create(`${onnxDir}/mimi_encoder.onnx`, { executionProviders: providers }),
      ort.InferenceSession.create(`${onnxDir}/text_conditioner.onnx`, { executionProviders: providers }),
      ort.InferenceSession.create(`${onnxDir}/${flowMainFile}`, { executionProviders: providers }),
      ort.InferenceSession.create(`${onnxDir}/${flowFlowFile}`, { executionProviders: providers }),
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
    const audioTensor = new ort.Tensor(
      "float32",
      floatAudio,
      [1, 1, floatAudio.length]
    );

    const encoded = await mimiEncoder.run({ audio: audioTensor });
    const firstOutName = (mimiEncoder as any).outputNames?.[0] as string | undefined;
    const voiceEmb = firstOutName ? (encoded as any)[firstOutName] : (Object.values(encoded)[0] as any);
    if (!voiceEmb) {
      throw new Error("PocketTTS mimi_encoder: missing output");
    }

    log.info(
      { precision, device, providers, lsdSteps, temperature },
      "PocketTTS ONNX initialized"
    );

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
    const out = await this.textConditioner.run({ token_ids: tokenIds } as any);
    const firstOutName = (this.textConditioner as any).outputNames?.[0] as string | undefined;
    const t = firstOutName ? (out as any)[firstOutName] : (Object.values(out)[0] as any);
    if (!t) throw new Error("PocketTTS text_conditioner: missing output");
    return t;
  }

  private async *runFlowLm(textEmbeddings: OrtTensor): AsyncGenerator<Float32Array> {
    const ort = this.ort;
    const state = initState(this.flowLmMain, ort);

    const emptySeq = new ort.Tensor("float32", new Float32Array(0), [1, 0, 32]);
    const emptyText = new ort.Tensor("float32", new Float32Array(0), [1, 0, 1024]);

    // Voice conditioning pass
    const resVoice = await this.flowLmMain.run({
      sequence: emptySeq,
      text_embeddings: this.voiceEmbeddings,
      ...state,
    } as any);
    updateStateFromOutputs(state, resVoice as any);

    // Text conditioning pass
    const resText = await this.flowLmMain.run({
      sequence: emptySeq,
      text_embeddings: textEmbeddings,
      ...state,
    } as any);
    updateStateFromOutputs(state, resText as any);

    // Autoregressive generation
    const curr = new Float32Array(32);
    curr.fill(Number.NaN);
    let currTensor = new ort.Tensor("float32", curr, [1, 1, 32]);

    const dt = 1.0 / this.lsdSteps;
    let eosStep: number | null = null;

    for (let step = 0; step < this.maxFrames; step += 1) {
      const resStep = await this.flowLmMain.run({
        sequence: currTensor,
        text_embeddings: emptyText,
        ...state,
      } as any);

      const outputNames = (this.flowLmMain as any).outputNames as string[] | undefined;
      const conditioningName = outputNames?.[0] ?? Object.keys(resStep)[0]!;
      const eosName = outputNames?.[1] ?? Object.keys(resStep)[1]!;

      const conditioning = (resStep as any)[conditioningName] as OrtTensor;
      const eos = (resStep as any)[eosName] as OrtTensor;
      if (!conditioning || !eos) {
        throw new Error("PocketTTS flow_lm_main: missing conditioning/EOS outputs");
      }
      updateStateFromOutputs(state, resStep as any);

      const eosData = tensorDataFloat32(eos);
      if (eosData[0]! > -4.0 && eosStep === null) {
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
        const flowOut = await this.flowLmFlow.run({
          c: conditioning,
          s: st.s,
          t: st.t,
          x: xTensor,
        } as any);
        const first = (this.flowLmFlow as any).outputNames?.[0] as string | undefined;
        const flowTensor = first ? (flowOut as any)[first] : (Object.values(flowOut)[0] as any);
        if (!flowTensor) throw new Error("PocketTTS flow_lm_flow: missing output");
        const delta = tensorDataFloat32(flowTensor);
        for (let i = 0; i < x.length; i += 1) {
          x[i] = x[i]! + delta[i]! * dt;
        }
      }

      yield x;
      currTensor = new ort.Tensor("float32", x, [1, 1, 32]);
    }
  }

  private async decodeLatentsChunk(
    frames: Float32Array[],
    state: Record<string, OrtTensor>
  ): Promise<Float32Array> {
    const ort = this.ort;
    const frameCount = frames.length;
    const flattened = new Float32Array(frameCount * 32);
    for (let i = 0; i < frameCount; i += 1) {
      flattened.set(frames[i]!, i * 32);
    }
    const latent = new ort.Tensor("float32", flattened, [1, frameCount, 32]);

    const out = await this.mimiDecoder.run({ latent, ...state } as any);
    updateStateFromOutputs(state, out as any);

    const firstOutName = (this.mimiDecoder as any).outputNames?.[0] as string | undefined;
    const audioTensor = firstOutName ? (out as any)[firstOutName] : (Object.values(out)[0] as any);
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
          decoderState
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

    this.logger.debug({ ms: Date.now() - start, textLength: text.length }, "PocketTTS stream ready");

    return {
      stream: Readable.from(iterable),
      format: `pcm;rate=${sampleRate}`,
    };
  }
}
