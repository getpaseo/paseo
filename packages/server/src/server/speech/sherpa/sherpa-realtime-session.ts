import { EventEmitter } from "node:events";
import { v4 as uuidv4 } from "uuid";

import type { RealtimeTranscriptionSession } from "../../dictation/dictation-stream-manager.js";
import { pcm16lePeakAbs, pcm16leToFloat32 } from "../audio.js";
import { SherpaOnlineRecognizerEngine } from "./sherpa-online-recognizer.js";

export class SherpaRealtimeTranscriptionSession
  extends EventEmitter
  implements RealtimeTranscriptionSession
{
  private readonly engine: SherpaOnlineRecognizerEngine;
  private stream: any | null = null;
  private connected = false;

  private currentItemId: string | null = null;
  private previousItemId: string | null = null;
  private lastPartialText = "";
  private readonly tailPaddingMs: number;

  constructor(params: { engine: SherpaOnlineRecognizerEngine; tailPaddingMs?: number }) {
    super();
    this.engine = params.engine;
    this.tailPaddingMs = params.tailPaddingMs ?? 500;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    this.stream = this.engine.createStream();
    this.currentItemId = uuidv4();
    this.connected = true;
  }

  appendPcm16Base64(base64Audio: string): void {
    if (!this.connected || !this.stream || !this.currentItemId) {
      this.emit("error", new Error("Sherpa realtime session not connected"));
      return;
    }

    try {
      const pcm16 = Buffer.from(base64Audio, "base64");
      const peak = pcm16lePeakAbs(pcm16);
      const peakFloat = peak / 32768.0;
      const targetPeak = 0.6;
      const maxGain = 50;
      const gain =
        peakFloat > 0 && peakFloat < targetPeak
          ? Math.min(maxGain, targetPeak / peakFloat)
          : 1;
      const floatSamples = pcm16leToFloat32(pcm16, gain);
      this.stream.acceptWaveform(this.engine.sampleRate, floatSamples);

      while (this.engine.recognizer.isReady(this.stream)) {
        this.engine.recognizer.decode(this.stream);
      }

      const text = String(this.engine.recognizer.getResult(this.stream)?.text ?? "").trim();
      if (text !== this.lastPartialText) {
        this.lastPartialText = text;
        this.emit("transcript", { itemId: this.currentItemId, transcript: text, isFinal: false });
      }
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  commit(): void {
    if (!this.connected || !this.stream || !this.currentItemId) {
      this.emit("error", new Error("Sherpa realtime session not connected"));
      return;
    }

    try {
      const padSamples = Math.max(0, Math.round((this.engine.sampleRate * this.tailPaddingMs) / 1000));
      if (padSamples > 0) {
        this.stream.acceptWaveform(this.engine.sampleRate, new Float32Array(padSamples));
      }

      while (this.engine.recognizer.isReady(this.stream)) {
        this.engine.recognizer.decode(this.stream);
      }

      const finalText = String(this.engine.recognizer.getResult(this.stream)?.text ?? "").trim();
      const itemId = this.currentItemId;
      const previousItemId = this.previousItemId;

      this.emit("committed", { itemId, previousItemId });
      this.emit("transcript", { itemId, transcript: finalText, isFinal: true });

      this.previousItemId = itemId;
      this.currentItemId = uuidv4();
      this.lastPartialText = "";
      this.engine.recognizer.reset(this.stream);
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  clear(): void {
    if (!this.connected || !this.stream) {
      return;
    }
    try {
      this.engine.recognizer.reset(this.stream);
      this.currentItemId = uuidv4();
      this.lastPartialText = "";
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  close(): void {
    if (!this.stream) {
      return;
    }
    try {
      this.stream.free?.();
    } catch {
      // ignore
    } finally {
      this.stream = null;
      this.connected = false;
    }
  }
}
