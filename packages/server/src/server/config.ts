import path from "node:path";

import type { PaseoDaemonConfig } from "./bootstrap.js";
import type { STTConfig } from "./agent/stt-openai.js";
import type { TTSConfig } from "./agent/tts-openai.js";
import { loadPersistedConfig } from "./persisted-config.js";
import {
  mergeAllowedHosts,
  parseAllowedHostsEnv,
  type AllowedHostsConfig,
} from "./allowed-hosts.js";

const DEFAULT_PORT = 6767;
const DEFAULT_RELAY_ENDPOINT = "relay.paseo.sh:443";
const DEFAULT_APP_BASE_URL = "https://app.paseo.sh";

function getDefaultListen(): string {
  // Main HTTP server defaults to TCP
  return `127.0.0.1:${DEFAULT_PORT}`;
}

export type CliConfigOverrides = Partial<{
  listen: string;
  relayEnabled: boolean;
  mcpEnabled: boolean;
  allowedHosts: AllowedHostsConfig;
}>;

function parseOpenAIConfig(
  env: NodeJS.ProcessEnv,
  configApiKey: string | undefined,
  config: {
    dictationSttModel?: string;
    dictationSttConfidenceThreshold?: number;
    voiceSttModel?: string;
    voiceTtsVoice?: TTSConfig["voice"];
    voiceTtsModel?: TTSConfig["model"];
  }
) {
  const apiKey = env.OPENAI_API_KEY ?? configApiKey;
  if (!apiKey) return undefined;

  const sttConfidenceThreshold = env.STT_CONFIDENCE_THRESHOLD
    ? parseFloat(env.STT_CONFIDENCE_THRESHOLD)
    : config.dictationSttConfidenceThreshold;
  const sttModel = (
    env.STT_MODEL ??
    config.voiceSttModel ??
    config.dictationSttModel
  ) as STTConfig["model"] | undefined;
  const ttsVoice = (env.TTS_VOICE || "alloy") as
    | "alloy"
    | "echo"
    | "fable"
    | "onyx"
    | "nova"
    | "shimmer";
  const ttsModel = (env.TTS_MODEL || config.voiceTtsModel || "tts-1") as
    | "tts-1"
    | "tts-1-hd";
  const configuredVoice = config.voiceTtsVoice;

  return {
    apiKey,
    stt: {
      apiKey,
      confidenceThreshold: sttConfidenceThreshold,
      ...(sttModel ? { model: sttModel } : {}),
    },
    tts: {
      apiKey,
      voice: configuredVoice ?? ttsVoice,
      model: ttsModel,
      responseFormat: "pcm" as TTSConfig["responseFormat"],
    },
  };
}

export function loadConfig(
  paseoHome: string,
  options?: {
    env?: NodeJS.ProcessEnv;
    cli?: CliConfigOverrides;
  }
): PaseoDaemonConfig {
  const env = options?.env ?? process.env;
  const persisted = loadPersistedConfig(paseoHome);

  // PASEO_LISTEN can be:
  // - host:port (TCP)
  // - /path/to/socket (Unix socket)
  // - unix:///path/to/socket (Unix socket)
  // Default is TCP at 127.0.0.1:6767
  const listen =
    options?.cli?.listen ??
    env.PASEO_LISTEN ??
    persisted.daemon?.listen ??
    getDefaultListen();

  const envCorsOrigins = env.PASEO_CORS_ORIGINS
    ? env.PASEO_CORS_ORIGINS.split(",").map((s) => s.trim())
    : [];

  const persistedCorsOrigins = persisted.daemon?.cors?.allowedOrigins ?? [];

  const allowedHosts = mergeAllowedHosts([
    persisted.daemon?.allowedHosts,
    parseAllowedHostsEnv(env.PASEO_ALLOWED_HOSTS),
    options?.cli?.allowedHosts,
  ]);

  const mcpEnabled =
    options?.cli?.mcpEnabled ?? persisted.daemon?.mcp?.enabled ?? true;

  const relayEnabled =
    options?.cli?.relayEnabled ?? persisted.daemon?.relay?.enabled ?? true;

  const relayEndpoint =
    env.PASEO_RELAY_ENDPOINT ??
    persisted.daemon?.relay?.endpoint ??
    DEFAULT_RELAY_ENDPOINT;

  const appBaseUrl =
    env.PASEO_APP_BASE_URL ?? persisted.app?.baseUrl ?? DEFAULT_APP_BASE_URL;

  const openai = parseOpenAIConfig(env, persisted.providers?.openai?.apiKey, {
    dictationSttModel: persisted.features?.dictation?.stt?.model,
    dictationSttConfidenceThreshold:
      persisted.features?.dictation?.stt?.confidenceThreshold,
    voiceSttModel: persisted.features?.voiceMode?.stt?.model,
    voiceTtsModel: persisted.features?.voiceMode?.tts?.model,
    voiceTtsVoice: persisted.features?.voiceMode?.tts?.voice,
  });

  const openrouterApiKey =
    env.OPENROUTER_API_KEY ?? persisted.providers?.openrouter?.apiKey ?? null;
  const voiceLlmModel = persisted.features?.voiceMode?.llm?.model ?? null;

  return {
    listen,
    paseoHome,
    corsAllowedOrigins: Array.from(
      new Set([...persistedCorsOrigins, ...envCorsOrigins].filter((s) => s.length > 0))
    ),
    allowedHosts,
    mcpEnabled,
    mcpDebug: env.MCP_DEBUG === "1",
    agentStoragePath: path.join(paseoHome, "agents"),
    staticDir: "public",
    agentClients: {},
    relayEnabled,
    relayEndpoint,
    appBaseUrl,
    openai,
    openrouterApiKey,
    voiceLlmModel,
  };
}
