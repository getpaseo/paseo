import type pino from "pino";

import type { SpeechToTextProvider, TranscriptionResult } from "../speech-provider.js";
import { Pcm16MonoResampler } from "../../agent/pcm16-resampler.js";
import { parsePcm16MonoWav, parsePcmRateFromFormat, pcm16lePeakAbs, pcm16leToFloat32 } from "../audio.js";
import { SherpaOnlineRecognizerEngine } from "./sherpa-online-recognizer.js";

export type SherpaSttConfig = {
  engine: SherpaOnlineRecognizerEngine;
  silencePeakThreshold?: number;
  tailPaddingMs?: number;
};

export class SherpaOnnxSTT implements SpeechToTextProvider {
  private readonly engine: SherpaOnlineRecognizerEngine;
  private readonly silencePeakThreshold: number;
  private readonly tailPaddingMs: number;
  private readonly logger: pino.Logger;

  constructor(config: SherpaSttConfig, logger: pino.Logger) {
    this.engine = config.engine;
    this.silencePeakThreshold = config.silencePeakThreshold ?? 300;
    this.tailPaddingMs = config.tailPaddingMs ?? 500;
    this.logger = logger.child({ module: "speech", provider: "sherpa-onnx", component: "stt" });
  }

  async transcribeAudio(audioBuffer: Buffer, format: string): Promise<TranscriptionResult> {
    const start = Date.now();

    let inputRate: number;
    let pcm16: Buffer;

    if (format.toLowerCase().includes("audio/wav")) {
      const parsed = parsePcm16MonoWav(audioBuffer);
      inputRate = parsed.sampleRate;
      pcm16 = parsed.pcm16;
    } else if (format.toLowerCase().includes("audio/pcm")) {
      inputRate = parsePcmRateFromFormat(format, this.engine.sampleRate) ?? this.engine.sampleRate;
      pcm16 = audioBuffer;
    } else {
      throw new Error(`Unsupported audio format for sherpa STT: ${format}`);
    }

    const peak = pcm16lePeakAbs(pcm16);
    if (peak < this.silencePeakThreshold) {
      return { text: "", duration: Date.now() - start, isLowConfidence: true };
    }

    let pcmForModel = pcm16;
    if (inputRate !== this.engine.sampleRate) {
      const resampler = new Pcm16MonoResampler({ inputRate, outputRate: this.engine.sampleRate });
      pcmForModel = resampler.processChunk(pcm16);
      inputRate = this.engine.sampleRate;
    }

    const peakForModel = pcm16lePeakAbs(pcmForModel);
    const peakFloat = peakForModel / 32768.0;
    const targetPeak = 0.6;
    const maxGain = 50;
    const gain =
      peakFloat > 0 && peakFloat < targetPeak
        ? Math.min(maxGain, targetPeak / peakFloat)
        : 1;

    const stream = this.engine.createStream();
    try {
      const floatSamples = pcm16leToFloat32(pcmForModel, gain);
      stream.acceptWaveform(inputRate, floatSamples);

      while (this.engine.recognizer.isReady(stream)) {
        this.engine.recognizer.decode(stream);
      }

      const padSamples = Math.max(0, Math.round((this.engine.sampleRate * this.tailPaddingMs) / 1000));
      if (padSamples > 0) {
        stream.acceptWaveform(this.engine.sampleRate, new Float32Array(padSamples));
      }

      while (this.engine.recognizer.isReady(stream)) {
        this.engine.recognizer.decode(stream);
      }

      const text = String(this.engine.recognizer.getResult(stream)?.text ?? "").trim();
      const duration = Date.now() - start;
      this.logger.debug({ duration, textLength: text.length }, "Sherpa transcription complete");
      return { text, duration, ...(text.length === 0 ? { isLowConfidence: true } : {}) };
    } finally {
      try {
        stream.free?.();
      } catch {
        // ignore
      }
    }
  }
}
