import type { Readable } from "node:stream";

export interface LogprobToken {
  token: string;
  logprob: number;
  bytes?: number[];
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
  logprobs?: LogprobToken[];
  avgLogprob?: number;
  isLowConfidence?: boolean;
}

export interface SpeechToTextProvider {
  transcribeAudio(audioBuffer: Buffer, format: string): Promise<TranscriptionResult>;
}

export interface SpeechStreamResult {
  stream: Readable;
  format: string;
}

export interface TextToSpeechProvider {
  synthesizeSpeech(text: string): Promise<SpeechStreamResult>;
}

