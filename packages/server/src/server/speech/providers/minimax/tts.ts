import { Readable } from "node:stream";
import type pino from "pino";
import { WebSocket } from "ws";

import type { SpeechStreamResult, TextToSpeechProvider } from "../../speech-provider.js";
import {
  DEFAULT_MINIMAX_TTS_MODEL,
  DEFAULT_MINIMAX_TTS_REGION,
  type MINIMAX_TTS_AUDIO_FORMATS,
  type MINIMAX_TTS_MODELS,
  type MINIMAX_TTS_REGIONS,
} from "./config.js";

export type MiniMaxTtsModel = (typeof MINIMAX_TTS_MODELS)[number];
export type MiniMaxTtsRegion = (typeof MINIMAX_TTS_REGIONS)[number];
export type MiniMaxTtsAudioFormat = (typeof MINIMAX_TTS_AUDIO_FORMATS)[number];

export const MINIMAX_TTS_ENDPOINTS: Record<MiniMaxTtsRegion, string> = {
  global_en: "https://api.minimax.io/v1/t2a_v2",
  cn_zh: "https://api.minimaxi.com/v1/t2a_v2",
};

export interface MiniMaxVoiceSetting {
  voiceId: string;
  speed?: number;
  volume?: number;
  pitch?: number;
  emotion?: string;
}

export interface MiniMaxAudioSetting {
  format?: MiniMaxTtsAudioFormat;
  sampleRate?: number;
  bitrate?: number;
  channel?: number;
}

export interface MiniMaxSynthesisOptions {
  languageBoost?: string;
  outputFormat?: "hex" | "url";
  voiceSetting?: MiniMaxVoiceSetting;
  pronunciationDictionary?: { tone: string[] };
  audioSetting?: MiniMaxAudioSetting;
  voiceModify?: Record<string, unknown>;
  subtitleEnabled?: boolean;
}

export interface MiniMaxTTSConfig {
  apiKey: string;
  baseUrl?: string;
  region?: MiniMaxTtsRegion;
  model?: MiniMaxTtsModel;
  voiceId?: string;
  responseFormat?: MiniMaxTtsAudioFormat;
}

export interface MiniMaxAsyncTask {
  taskId?: string;
  taskToken?: string;
  fileId?: number;
}

export interface MiniMaxAsyncStatus {
  taskId?: string;
  status?: string;
  fileId?: number;
}

interface MiniMaxApiResponse {
  data?: {
    audio?: string;
    status?: string;
    task_id?: string;
    task_token?: string;
    file_id?: number;
  };
  task_id?: string;
  task_token?: string;
  file_id?: number;
  status?: string;
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
}

type MiniMaxRequest = Record<string, unknown>;

function buildVoiceSetting(setting: MiniMaxVoiceSetting): Record<string, unknown> {
  const result: Record<string, unknown> = { voice_id: setting.voiceId };
  if (setting.speed !== undefined) result.speed = setting.speed;
  if (setting.volume !== undefined) result.vol = setting.volume;
  if (setting.pitch !== undefined) result.pitch = setting.pitch;
  if (setting.emotion) result.emotion = setting.emotion;
  return result;
}

function buildAudioSetting(
  setting: MiniMaxAudioSetting | undefined,
  defaultFormat: MiniMaxTtsAudioFormat,
): Record<string, unknown> {
  const result: Record<string, unknown> = { format: setting?.format ?? defaultFormat };
  if (setting?.sampleRate !== undefined) result.sample_rate = setting.sampleRate;
  if (setting?.bitrate !== undefined) result.bitrate = setting.bitrate;
  if (setting?.channel !== undefined) result.channel = setting.channel;
  return result;
}

function endpointForPath(config: MiniMaxTTSConfig, path: string): string {
  const synthesisEndpoint =
    config.baseUrl ?? MINIMAX_TTS_ENDPOINTS[config.region ?? DEFAULT_MINIMAX_TTS_REGION];
  const url = new URL(synthesisEndpoint);
  url.pathname = path;
  url.search = "";
  return url.toString();
}

export function resolveMiniMaxTtsUrls(config: MiniMaxTTSConfig): {
  synthesis: string;
  asyncCreate: string;
  asyncQuery: string;
  websocket: string;
} {
  const websocket = new URL(endpointForPath(config, "/ws/v1/t2a_v2"));
  websocket.protocol = "wss:";
  return {
    synthesis: endpointForPath(config, "/v1/t2a_v2"),
    asyncCreate: endpointForPath(config, "/v1/t2a_async_v2"),
    asyncQuery: endpointForPath(config, "/v1/query/t2a_async_query_v2"),
    websocket: websocket.toString(),
  };
}

function buildSynthesisRequest(
  text: string,
  config: MiniMaxTTSConfig,
  options: MiniMaxSynthesisOptions,
  stream: boolean,
): MiniMaxRequest {
  const voiceSetting =
    options.voiceSetting ?? (config.voiceId ? { voiceId: config.voiceId } : null);
  const request: MiniMaxRequest = {
    model: config.model ?? DEFAULT_MINIMAX_TTS_MODEL,
    text,
    stream,
    output_format: options.outputFormat ?? "hex",
    audio_setting: buildAudioSetting(options.audioSetting, config.responseFormat ?? "mp3"),
  };
  if (options.languageBoost) request.language_boost = options.languageBoost;
  if (voiceSetting) request.voice_setting = buildVoiceSetting(voiceSetting);
  if (options.pronunciationDictionary) {
    request.pronunciation_dict = options.pronunciationDictionary;
  }
  if (options.voiceModify) request.voice_modify = options.voiceModify;
  if (options.subtitleEnabled !== undefined) request.subtitle_enable = options.subtitleEnabled;
  return request;
}

function buildAsyncRequest(
  text: string,
  config: MiniMaxTTSConfig,
  options: MiniMaxSynthesisOptions,
): MiniMaxRequest {
  const request = buildSynthesisRequest(text, config, options, false);
  delete request.stream;
  delete request.output_format;
  delete request.subtitle_enable;
  return request;
}

export class MiniMaxTTSError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MiniMaxTTSError";
  }
}

export class MiniMaxTTS implements TextToSpeechProvider {
  private readonly config: MiniMaxTTSConfig;
  private readonly logger: pino.Logger;

  constructor(ttsConfig: MiniMaxTTSConfig, parentLogger: pino.Logger) {
    this.config = {
      region: DEFAULT_MINIMAX_TTS_REGION,
      model: DEFAULT_MINIMAX_TTS_MODEL,
      responseFormat: "mp3",
      ...ttsConfig,
    };
    this.logger = parentLogger.child({ module: "agent", provider: "minimax", component: "tts" });
  }

  public getConfig(): MiniMaxTTSConfig {
    return this.config;
  }

  public async synthesizeSpeech(
    text: string,
    options: MiniMaxSynthesisOptions = {},
  ): Promise<SpeechStreamResult> {
    const response = await this.request(
      "/v1/t2a_v2",
      buildSynthesisRequest(text, this.config, options, false),
    );
    const audio = response.data?.audio;
    if (!audio) {
      throw new MiniMaxTTSError("MiniMax TTS response did not include audio data");
    }

    return {
      stream: Readable.from(Buffer.from(audio, "hex")),
      format: options.audioSetting?.format ?? this.config.responseFormat ?? "mp3",
    };
  }

  public async createAsyncSpeech(
    text: string,
    options: MiniMaxSynthesisOptions = {},
  ): Promise<MiniMaxAsyncTask> {
    const response = await this.request(
      "/v1/t2a_async_v2",
      buildAsyncRequest(text, this.config, options),
    );
    return {
      taskId: response.task_id ?? response.data?.task_id,
      taskToken: response.task_token ?? response.data?.task_token,
      fileId: response.file_id ?? response.data?.file_id,
    };
  }

  public async queryAsyncSpeech(taskId: string): Promise<MiniMaxAsyncStatus> {
    const response = await this.request("/v1/query/t2a_async_query_v2", { task_id: taskId });
    return {
      taskId: response.task_id ?? response.data?.task_id,
      status: response.status ?? response.data?.status,
      fileId: response.file_id ?? response.data?.file_id,
    };
  }

  public createWebSocket(): WebSocket {
    return new WebSocket(resolveMiniMaxTtsUrls(this.config).websocket, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    });
  }

  public buildWebSocketRequest(
    text: string,
    options: MiniMaxSynthesisOptions = {},
  ): MiniMaxRequest {
    this.validateText(text);
    return buildSynthesisRequest(text, this.config, options, true);
  }

  private validateText(text: string): void {
    if (!text || text.trim().length === 0) {
      throw new MiniMaxTTSError("Cannot synthesize empty text");
    }
  }

  private async request(path: string, body: MiniMaxRequest): Promise<MiniMaxApiResponse> {
    const text = body.text;
    if (typeof text === "string") this.validateText(text);

    let response: Response;
    try {
      response = await fetch(endpointForPath(this.config, path), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new MiniMaxTTSError("MiniMax TTS request failed", undefined, { cause: error });
    }

    const payload: unknown = await response.json().catch(() => null);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new MiniMaxTTSError("MiniMax TTS returned an invalid response", response.status);
    }
    const parsed = payload as MiniMaxApiResponse;
    const apiStatus = parsed.base_resp?.status_code;
    if (!response.ok || (apiStatus !== undefined && apiStatus !== 0)) {
      const detail = parsed.base_resp?.status_msg ?? response.statusText;
      this.logger.error({ statusCode: response.status, apiStatus }, "MiniMax TTS request failed");
      throw new MiniMaxTTSError(
        detail ? `MiniMax TTS request failed: ${detail}` : "MiniMax TTS request failed",
        response.status,
      );
    }
    return parsed;
  }
}
