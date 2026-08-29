import { Readable } from "node:stream";

import { GoogleGenAI } from "@google/genai";
import type { Logger } from "pino";
import { z } from "zod";

import type { SpeechStreamResult, TextToSpeechProvider } from "../../speech-provider.js";
import type { GeminiTtsConfig } from "./config.js";

const PCM_MIME_TYPE = "audio/l16";
const PCM_SAMPLE_RATE = 24000;

const AudioInteractionSchema = z.object({
  output_audio: z.object({
    type: z.literal("audio"),
    data: z.base64(),
    mime_type: z.string().optional(),
    sample_rate: z.number().int().positive().optional(),
    channels: z.number().int().positive().optional(),
  }),
});

export interface GeminiTtsRequest extends GeminiTtsConfig {
  text: string;
}

export interface GeminiSpeechSynthesisApi {
  synthesize(request: GeminiTtsRequest): Promise<{ pcm16: Buffer; sampleRate: number }>;
}

function createGoogleSpeechSynthesisApi(apiKey: string): GeminiSpeechSynthesisApi {
  const client = new GoogleGenAI({ apiKey });

  return {
    async synthesize(request) {
      const interaction = await client.interactions.create({
        model: request.model,
        input: `Synthesize speech from the transcript below. Read only the transcript.\n\nTranscript:\n${request.text}`,
        store: false,
        response_format: {
          type: "audio",
        },
        generation_config: {
          speech_config: [{ voice: request.voice }],
        },
      });
      const audio = AudioInteractionSchema.parse(interaction).output_audio;
      const mimeType = audio.mime_type?.split(";", 1)[0]?.trim().toLowerCase();
      if (mimeType && mimeType !== PCM_MIME_TYPE) {
        throw new Error(`Unexpected Gemini TTS audio format: ${audio.mime_type}`);
      }
      if (audio.channels !== undefined && audio.channels !== 1) {
        throw new Error(`Unexpected Gemini TTS channel count: ${audio.channels}`);
      }

      const pcm16 = Buffer.from(audio.data, "base64");
      if (pcm16.length === 0 || pcm16.length % 2 !== 0) {
        throw new Error(`Unexpected Gemini TTS PCM byte length: ${pcm16.length}`);
      }
      return {
        pcm16,
        sampleRate: audio.sample_rate ?? PCM_SAMPLE_RATE,
      };
    },
  };
}

export class GeminiTTS implements TextToSpeechProvider {
  private readonly config: GeminiTtsConfig;
  private readonly api: GeminiSpeechSynthesisApi;
  private readonly logger: Logger;

  constructor(params: {
    apiKey: string;
    config: GeminiTtsConfig;
    logger: Logger;
    api?: GeminiSpeechSynthesisApi;
  }) {
    this.config = params.config;
    this.api = params.api ?? createGoogleSpeechSynthesisApi(params.apiKey);
    this.logger = params.logger.child({ provider: "gemini", component: "tts" });
    this.logger.info(params.config, "Gemini TTS initialized");
  }

  public async synthesizeSpeech(text: string): Promise<SpeechStreamResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Cannot synthesize empty text");
    }

    try {
      const speech = await this.api.synthesize({
        model: this.config.model,
        voice: this.config.voice,
        text: trimmed,
      });
      return {
        stream: Readable.from([speech.pcm16]),
        format: `pcm;rate=${speech.sampleRate}`,
      };
    } catch (error) {
      this.logger.error({ err: error }, "Gemini TTS synthesis failed");
      throw new Error("Gemini TTS synthesis failed", { cause: error });
    }
  }
}
