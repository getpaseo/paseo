import OpenAI from "openai";
import { Readable } from "stream";
import { getRootLogger } from "../logger.js";

const logger = getRootLogger().child({ module: "agent", provider: "openai", component: "tts" });

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
  logger.info(
    { voice: config.voice, model: config.model, format: config.responseFormat },
    "TTS (OpenAI) initialized"
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
    logger.debug(
      { textLength: text.length, preview: text.substring(0, 50) },
      "Synthesizing speech"
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
    logger.debug({ duration }, "Speech synthesis stream ready");

    return {
      stream: audioStream,
      format: config.responseFormat || "mp3",
    };
  } catch (error: any) {
    logger.error({ err: error }, "Speech synthesis error");
    throw new Error(`TTS synthesis failed: ${error.message}`);
  }
}

export function isTTSInitialized(): boolean {
  return openaiClient !== null && config !== null;
}

export function getTTSConfig(): TTSConfig | null {
  return config;
}
