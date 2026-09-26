import type pino from "pino";
import type { OpenAI } from "openai";
import { Readable } from "node:stream";
import { ReadableStream } from "node:stream/web";
import type { OpenAiSpeechEndpointConfig } from "./config.js";
import { createOpenAiSpeechClient } from "./client.js";
import type { SpeechStreamResult, TextToSpeechProvider } from "../../speech-provider.js";

export type { SpeechStreamResult };

export interface TTSConfig extends OpenAiSpeechEndpointConfig {
  model?: string;
  voice?: string;
  responseFormat?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
}

export class OpenAITTS implements TextToSpeechProvider {
  private readonly openaiClient: OpenAI;
  private readonly config: TTSConfig;
  private readonly logger: pino.Logger;

  constructor(ttsConfig: TTSConfig, parentLogger: pino.Logger, fetch?: typeof globalThis.fetch) {
    this.config = {
      model: "tts-1",
      voice: "alloy",
      responseFormat: "pcm",
      ...ttsConfig,
    };
    this.logger = parentLogger.child({ module: "agent", provider: "openai", component: "tts" });
    this.openaiClient = createOpenAiSpeechClient(ttsConfig, fetch);

    this.logger.info(
      { voice: this.config.voice, model: this.config.model, format: this.config.responseFormat },
      "TTS (OpenAI) initialized",
    );
  }

  public getConfig(): TTSConfig {
    return this.config;
  }

  public async synthesizeSpeech(text: string, signal?: AbortSignal): Promise<SpeechStreamResult> {
    if (!text || text.trim().length === 0) {
      throw new Error("Cannot synthesize empty text");
    }

    const startTime = Date.now();

    try {
      this.logger.debug(
        { textLength: text.length, preview: text.substring(0, 50) },
        "Synthesizing speech",
      );

      const response = await this.openaiClient.audio.speech.create(
        {
          model: this.config.model!,
          voice: this.config.voice!,
          input: text,
          response_format: this.config.responseFormat as
            | "mp3"
            | "opus"
            | "aac"
            | "flac"
            | "wav"
            | "pcm",
        },
        { signal },
      );

      if (!(response.body instanceof ReadableStream)) {
        throw new Error("Speech endpoint returned no readable audio body");
      }
      const audioStream = Readable.fromWeb(response.body);

      const duration = Date.now() - startTime;
      this.logger.debug({ duration }, "Speech synthesis stream ready");

      return {
        stream: audioStream,
        format: this.config.responseFormat || "mp3",
      };
    } catch (error) {
      this.logger.error({ err: error }, "Speech synthesis error");
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`TTS synthesis failed: ${message}`, { cause: error });
    }
  }
}
