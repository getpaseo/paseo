import type pino from "pino";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import type { SpeechStreamResult, TextToSpeechProvider } from "../../speech-provider.js";

export type { SpeechStreamResult };

export const DEFAULT_ELEVENLABS_TTS_MODEL = "eleven_multilingual_v2";
export const DEFAULT_ELEVENLABS_TTS_OUTPUT_FORMAT = "mp3_44100_128";
export const DEFAULT_ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";

export interface ElevenLabsTtsConfig {
  apiKey: string;
  baseUrl?: string;
  voiceId: string;
  modelId?: string;
  outputFormat?: string;
  fetchImpl?: typeof fetch;
}

interface ElevenLabsErrorPayload {
  detail?: { message?: string; status?: string } | string;
  message?: string;
}

async function parseElevenLabsError(response: Response): Promise<string> {
  const fallback = `ElevenLabs TTS request failed with status ${response.status}`;
  try {
    const payload = (await response.json()) as ElevenLabsErrorPayload;
    if (typeof payload?.detail === "string" && payload.detail.length > 0) {
      return payload.detail;
    }
    if (
      payload?.detail &&
      typeof payload.detail === "object" &&
      typeof payload.detail.message === "string" &&
      payload.detail.message.length > 0
    ) {
      return payload.detail.message;
    }
    if (typeof payload?.message === "string" && payload.message.length > 0) {
      return payload.message;
    }
  } catch {
    // ignore parse failures
  }
  return fallback;
}

export class ElevenLabsTTS implements TextToSpeechProvider {
  public readonly id = "elevenlabs" as const;
  private readonly config: ElevenLabsTtsConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: pino.Logger;

  constructor(ttsConfig: ElevenLabsTtsConfig, parentLogger: pino.Logger) {
    this.config = ttsConfig;
    this.fetchImpl = ttsConfig.fetchImpl ?? globalThis.fetch;
    this.logger = parentLogger.child({
      module: "agent",
      provider: "elevenlabs",
      component: "tts",
    });
    this.logger.info(
      {
        voiceId: ttsConfig.voiceId,
        modelId: ttsConfig.modelId ?? DEFAULT_ELEVENLABS_TTS_MODEL,
        outputFormat: ttsConfig.outputFormat ?? DEFAULT_ELEVENLABS_TTS_OUTPUT_FORMAT,
      },
      "TTS (ElevenLabs) initialized",
    );
  }

  public async synthesizeSpeech(text: string): Promise<SpeechStreamResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Cannot synthesize empty text");
    }

    const modelId = this.config.modelId ?? DEFAULT_ELEVENLABS_TTS_MODEL;
    const outputFormat = this.config.outputFormat ?? DEFAULT_ELEVENLABS_TTS_OUTPUT_FORMAT;
    const baseUrl = (this.config.baseUrl ?? ELEVENLABS_BASE_URL).replace(/\/+$/, "");
    const url = `${baseUrl}/v1/text-to-speech/${encodeURIComponent(this.config.voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;

    const startTime = Date.now();

    this.logger.debug(
      { textLength: trimmed.length, preview: trimmed.substring(0, 50), modelId, outputFormat },
      "Synthesizing speech",
    );

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "xi-api-key": this.config.apiKey,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: trimmed,
          model_id: modelId,
        }),
      });
    } catch (error) {
      this.logger.error({ err: error }, "Speech synthesis request error");
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`TTS synthesis failed: ${message}`, { cause: error });
    }

    if (!response.ok || !response.body) {
      const message = await parseElevenLabsError(response);
      this.logger.error({ status: response.status, message }, "Speech synthesis error");
      throw new Error(`TTS synthesis failed: ${message}`);
    }

    const stream = Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>);
    this.logger.debug({ duration: Date.now() - startTime }, "Speech synthesis stream ready");

    return {
      stream,
      format: "mp3",
    };
  }
}
