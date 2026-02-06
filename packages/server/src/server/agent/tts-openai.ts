import type pino from "pino";
import OpenAI from "openai";
import { Readable } from "node:stream";
import type { SpeechStreamResult } from "../speech/speech-provider.js";

export type { SpeechStreamResult };

export interface TTSConfig {
  apiKey: string;
  model?: "tts-1" | "tts-1-hd";
  voice?: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
  responseFormat?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
}

export class OpenAITTS {
  private readonly openaiClient: OpenAI;
  private readonly config: TTSConfig;
  private readonly logger: pino.Logger;

  constructor(ttsConfig: TTSConfig, parentLogger: pino.Logger) {
    this.config = {
      model: "tts-1",
      voice: "alloy",
      responseFormat: "pcm",
      ...ttsConfig,
    };
    this.logger = parentLogger.child({ module: "agent", provider: "openai", component: "tts" });
    this.openaiClient = new OpenAI({
      apiKey: ttsConfig.apiKey,
    });

    this.logger.info(
      { voice: this.config.voice, model: this.config.model, format: this.config.responseFormat },
      "TTS (OpenAI) initialized"
    );
  }

  public getConfig(): TTSConfig {
    return this.config;
  }

  public async synthesizeSpeech(text: string): Promise<SpeechStreamResult> {
    if (!text || text.trim().length === 0) {
      throw new Error("Cannot synthesize empty text");
    }

    const startTime = Date.now();

    try {
      this.logger.debug(
        { textLength: text.length, preview: text.substring(0, 50) },
        "Synthesizing speech"
      );

      const response = await this.openaiClient.audio.speech.create({
        model: this.config.model!,
        voice: this.config.voice!,
        input: text,
        response_format: this.config.responseFormat as "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm",
      });

      const audioStream = response.body as unknown as Readable;

      const duration = Date.now() - startTime;
      this.logger.debug({ duration }, "Speech synthesis stream ready");

      return {
        stream: audioStream,
        format: this.config.responseFormat || "mp3",
      };
    } catch (error: any) {
      this.logger.error({ err: error }, "Speech synthesis error");
      throw new Error(`TTS synthesis failed: ${error.message}`);
    }
  }
}
