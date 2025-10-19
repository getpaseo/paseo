import OpenAI from "openai";
import { Readable } from "stream";

export interface TTSConfig {
  apiKey: string;
  model?: "tts-1" | "tts-1-hd";
  voice?: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
  responseFormat?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
}

export interface SpeechResult {
  audio: Buffer;
  format: string;
}

let openaiClient: OpenAI | null = null;
let config: TTSConfig | null = null;

export function initializeTTS(ttsConfig: TTSConfig): void {
  config = {
    model: "tts-1",
    voice: "alloy",
    responseFormat: "mp3",
    ...ttsConfig,
  };
  openaiClient = new OpenAI({
    apiKey: ttsConfig.apiKey,
  });
  console.log(
    `✓ TTS (OpenAI) initialized with voice: ${config.voice}, model: ${config.model}`
  );
}

export async function synthesizeSpeech(text: string): Promise<SpeechResult> {
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
      response_format: config.responseFormat as "mp3" | "opus" | "aac" | "flac",
    });

    // Response is a stream, convert to buffer
    const audioBuffer = await streamToBuffer(
      response.body as unknown as Readable
    );

    const duration = Date.now() - startTime;
    console.log(
      `[TTS] Speech synthesis complete in ${duration}ms (${audioBuffer.length} bytes)`
    );

    return {
      audio: audioBuffer,
      format: config.responseFormat || "mp3",
    };
  } catch (error: any) {
    console.error("[TTS] Speech synthesis error:", error);
    throw new Error(`TTS synthesis failed: ${error.message}`);
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];

  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });

    stream.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    stream.on("error", (error) => {
      reject(error);
    });
  });
}

export function isTTSInitialized(): boolean {
  return openaiClient !== null && config !== null;
}

export function getTTSConfig(): TTSConfig | null {
  return config;
}
