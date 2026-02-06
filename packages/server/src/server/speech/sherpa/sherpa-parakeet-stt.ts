import type pino from "pino";

import type { SpeechToTextProvider, TranscriptionResult } from "../speech-provider.js";
import { Pcm16MonoResampler } from "../../agent/pcm16-resampler.js";
import { parsePcm16MonoWav, parsePcmRateFromFormat, pcm16lePeakAbs, pcm16leToFloat32 } from "../audio.js";
import { SherpaOfflineRecognizerEngine } from "./sherpa-offline-recognizer.js";

export type SherpaParakeetSttConfig = {
  engine: SherpaOfflineRecognizerEngine;
  silencePeakThreshold?: number;
};

export class SherpaOnnxParakeetSTT implements SpeechToTextProvider {
  private readonly engine: SherpaOfflineRecognizerEngine;
  private readonly silencePeakThreshold: number;
  private readonly logger: pino.Logger;

  constructor(config: SherpaParakeetSttConfig, logger: pino.Logger) {
    this.engine = config.engine;
    this.silencePeakThreshold = config.silencePeakThreshold ?? 300;
    this.logger = logger.child({ module: "speech", provider: "sherpa-onnx", component: "parakeet-stt" });
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
      throw new Error(`Unsupported audio format for sherpa Parakeet STT: ${format}`);
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
      this.engine.acceptWaveform(stream, inputRate, floatSamples);
      this.engine.recognizer.decode(stream);
      const result = this.engine.recognizer.getResult(stream);
      const text = String(result?.text ?? result ?? "").trim();
      const duration = Date.now() - start;
      this.logger.debug({ duration, textLength: text.length }, "Parakeet transcription complete");
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
