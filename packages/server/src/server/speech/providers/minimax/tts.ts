import { Readable } from "node:stream";
import type pino from "pino";
import type { SpeechStreamResult, TextToSpeechProvider } from "../../speech-provider.js";

export type { SpeechStreamResult };

export type MiniMaxTTSVoice =
  | "English_Graceful_Lady"
  | "English_Insightful_Speaker"
  | "English_radiant_girl"
  | "English_Persuasive_Man"
  | "English_Lucky_Robot"
  | "English_expressive_narrator";

export interface MiniMaxTTSConfig {
  apiKey: string;
  model?: "speech-2.8-hd" | "speech-2.8-turbo";
  voice?: MiniMaxTTSVoice;
  baseUrl?: string;
}

const DEFAULT_MINIMAX_TTS_MODEL = "speech-2.8-hd";
const DEFAULT_MINIMAX_TTS_VOICE: MiniMaxTTSVoice = "English_Graceful_Lady";
const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io";

export class MiniMaxTTS implements TextToSpeechProvider {
  private readonly config: Required<MiniMaxTTSConfig>;
  private readonly logger: pino.Logger;

  constructor(ttsConfig: MiniMaxTTSConfig, parentLogger: pino.Logger) {
    this.config = {
      model: DEFAULT_MINIMAX_TTS_MODEL,
      voice: DEFAULT_MINIMAX_TTS_VOICE,
      baseUrl: DEFAULT_MINIMAX_BASE_URL,
      ...ttsConfig,
    };
    this.logger = parentLogger.child({ module: "agent", provider: "minimax", component: "tts" });

    this.logger.info(
      { voice: this.config.voice, model: this.config.model },
      "TTS (MiniMax) initialized",
    );
  }

  public getConfig(): Required<MiniMaxTTSConfig> {
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
        "Synthesizing speech via MiniMax",
      );

      const baseUrl = this.config.baseUrl.replace(/\/$/, "");
      const response = await fetch(`${baseUrl}/v1/t2a_v2`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          text,
          stream: true,
          voice_setting: {
            voice_id: this.config.voice,
            speed: 1,
            vol: 1,
            pitch: 0,
          },
          audio_setting: {
            sample_rate: 32000,
            bitrate: 128000,
            format: "mp3",
            channel: 1,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`MiniMax TTS API error ${response.status}: ${errorText}`);
      }

      if (!response.body) {
        throw new Error("MiniMax TTS API returned no response body");
      }

      const audioChunks = await this.collectSseAudioChunks(response);
      const duration = Date.now() - startTime;

      if (audioChunks.length === 0) {
        throw new Error("MiniMax TTS returned no audio data");
      }

      const audioBuffer = Buffer.concat(audioChunks);
      this.logger.debug(
        { duration, byteLength: audioBuffer.length },
        "MiniMax TTS synthesis complete",
      );

      return {
        stream: Readable.from([audioBuffer]),
        format: "mp3",
      };
    } catch (error: any) {
      this.logger.error({ err: error }, "MiniMax TTS synthesis error");
      throw new Error(`MiniMax TTS synthesis failed: ${error.message}`);
    }
  }

  private async collectSseAudioChunks(response: Response): Promise<Buffer[]> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const audioChunks: Buffer[] = [];
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const jsonStr = line.slice(5).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;

          try {
            const eventData = JSON.parse(jsonStr) as {
              data?: { audio?: string; status?: number };
              base_resp?: { status_code?: number; status_msg?: string };
            };

            if (
              eventData.base_resp?.status_code !== undefined &&
              eventData.base_resp.status_code !== 0
            ) {
              throw new Error(
                `MiniMax TTS API error: ${eventData.base_resp.status_msg ?? "unknown error"}`,
              );
            }

            if (eventData.data?.audio) {
              audioChunks.push(Buffer.from(eventData.data.audio, "hex"));
            }
          } catch (parseError: any) {
            if (parseError.message?.startsWith("MiniMax TTS")) {
              throw parseError;
            }
            // Skip malformed SSE events
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return audioChunks;
  }
}
