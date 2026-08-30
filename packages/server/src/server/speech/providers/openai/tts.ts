import type pino from "pino";
import { OpenAI } from "openai";
import { Readable } from "node:stream";
import type { SpeechStreamResult, TextToSpeechProvider } from "../../speech-provider.js";

export type { SpeechStreamResult };

export interface TTSConfig {
  apiKey: string;
  baseUrl?: string;
  model?: "tts-1" | "tts-1-hd" | "gpt-4o-mini-tts" | (string & {});
  voice?: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" | (string & {});
  /** Delivery steering (tone, pace, accent). Ignored by tts-1/tts-1-hd. */
  instructions?: string;
  responseFormat?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
}

function modelSupportsInstructions(model: string): boolean {
  return model !== "tts-1" && model !== "tts-1-hd";
}

export class OpenAITTS implements TextToSpeechProvider {
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
      ...(ttsConfig.baseUrl ? { baseURL: ttsConfig.baseUrl } : {}),
    });

    this.logger.info(
      { voice: this.config.voice, model: this.config.model, format: this.config.responseFormat },
      "TTS (OpenAI) initialized",
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
        "Synthesizing speech",
      );

      const model = this.config.model!;
      const response = await this.openaiClient.audio.speech.create({
        model,
        voice: this.config.voice!,
        input: text,
        // The tts-1 generation rejects the instructions parameter outright.
        ...(this.config.instructions && modelSupportsInstructions(model)
          ? { instructions: this.config.instructions }
          : {}),
        response_format: this.config.responseFormat as
          | "mp3"
          | "opus"
          | "aac"
          | "flac"
          | "wav"
          | "pcm",
      });

      const audioStream = response.body as unknown as Readable;

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
