import OpenAI from "openai";
import { Readable } from "stream";

export interface TTSConfig {
  apiKey: string;
  model?: "tts-1" | "tts-1-hd";
  voice?: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
  responseFormat?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
}

export interface SpeechStreamResult {
  stream: Readable;
  format: string;
}

let openaiClient: OpenAI | null = null;
let config: TTSConfig | null = null;

export function initializeTTS(ttsConfig: TTSConfig): void {
  config = {
    model: "tts-1",
    voice: "alloy",
    responseFormat: "pcm",
    ...ttsConfig,
  };
  openaiClient = new OpenAI({
    apiKey: ttsConfig.apiKey,
  });
  console.log(
    `✓ TTS (OpenAI) initialized with voice: ${config.voice}, model: ${config.model}, format: ${config.responseFormat}`
  );
}

export async function synthesizeSpeech(
  text: string
): Promise<SpeechStreamResult> {
  if (!openaiClient || !config) {
    throw new Error("TTS not initialized. Call initializeTTS() first.");
  }

  if (!text || text.trim().length === 0) {
    throw new Error("Cannot synthesize empty text");
  }

  const startTime = Date.now();

  try {
    console.log(
      `[TTS] Synthesizing speech: "${text.substring(0, 50)}${
        text.length > 50 ? "..." : ""
      }"`
    );

    // Call OpenAI TTS API with streaming
    const response = await openaiClient.audio.speech.create({
      model: config.model!,
      voice: config.voice!,
      input: text,
      // speed: 1.2,
      response_format: config.responseFormat as "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm",
    });

    const audioStream = response.body as unknown as Readable;

    const duration = Date.now() - startTime;
    console.log(`[TTS] Speech synthesis stream ready in ${duration}ms`);

    return {
      stream: audioStream,
      format: config.responseFormat || "mp3",
    };
  } catch (error: any) {
    console.error("[TTS] Speech synthesis error:", error);
    throw new Error(`TTS synthesis failed: ${error.message}`);
  }
}

export function isTTSInitialized(): boolean {
  return openaiClient !== null && config !== null;
}

export function getTTSConfig(): TTSConfig | null {
  return config;
}
