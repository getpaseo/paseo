import path from "node:path";

import type { PaseoDaemonConfig } from "./bootstrap.js";
import type { STTConfig } from "./agent/stt-openai.js";
import type { TTSConfig } from "./agent/tts-openai.js";
import { loadPersistedConfig } from "./persisted-config.js";

const DEFAULT_LISTEN = "127.0.0.1:6767";
const DEFAULT_AGENT_MCP_ROUTE = "/mcp/agents";
const DEFAULT_RELAY_ENDPOINT = "relay.paseo.sh:443";
const DEFAULT_APP_BASE_URL = "https://app.paseo.sh";

function parseOpenAIConfig(env: NodeJS.ProcessEnv) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return undefined;

  const sttConfidenceThreshold = env.STT_CONFIDENCE_THRESHOLD
    ? parseFloat(env.STT_CONFIDENCE_THRESHOLD)
    : undefined;
  const sttModel = env.STT_MODEL as STTConfig["model"];
  const ttsVoice = (env.TTS_VOICE || "alloy") as
    | "alloy"
    | "echo"
    | "fable"
    | "onyx"
    | "nova"
    | "shimmer";
  const ttsModel = (env.TTS_MODEL || "tts-1") as "tts-1" | "tts-1-hd";

  return {
    apiKey,
    stt: {
      apiKey,
      confidenceThreshold: sttConfidenceThreshold,
      ...(sttModel ? { model: sttModel } : {}),
    },
    tts: {
      apiKey,
      voice: ttsVoice,
      model: ttsModel,
      responseFormat: "pcm" as TTSConfig["responseFormat"],
    },
  };
}

function getListenForMcp(listen: string): string {
  // For Unix sockets, MCP still needs HTTP - use localhost
  if (listen.startsWith("/") || listen.startsWith("~") || listen.includes(".sock")) {
    return "127.0.0.1:6767";
  }
  if (listen.startsWith("unix://")) {
    return "127.0.0.1:6767";
  }
  // TCP: extract host:port
  if (listen.includes(":")) {
    const [host, port] = listen.split(":");
    return `${host || "127.0.0.1"}:${port}`;
  }
  // Just port
  return `127.0.0.1:${listen}`;
}

export function loadConfig(
  paseoHome: string,
  env: NodeJS.ProcessEnv = process.env
): PaseoDaemonConfig {
  const persisted = loadPersistedConfig(paseoHome);

  const listen = env.PASEO_LISTEN ?? persisted.listen ?? DEFAULT_LISTEN;
  const mcpListen = getListenForMcp(listen);

  const envCorsOrigins = env.PASEO_CORS_ORIGINS
    ? env.PASEO_CORS_ORIGINS.split(",").map((s) => s.trim())
    : [];

  return {
    listen,
    paseoHome,
    corsAllowedOrigins: [...persisted.cors.allowedOrigins, ...envCorsOrigins],
    agentMcpRoute: DEFAULT_AGENT_MCP_ROUTE,
    agentMcpAllowedHosts: [mcpListen, `localhost:${mcpListen.split(":")[1]}`],
    mcpDebug: env.MCP_DEBUG === "1",
    agentControlMcp: {
      url: `http://${mcpListen}${DEFAULT_AGENT_MCP_ROUTE}`,
    },
    agentStoragePath: path.join(paseoHome, "agents"),
    staticDir: "public",
    agentClients: {},
    relayEnabled: true,
    relayEndpoint: env.PASEO_RELAY_ENDPOINT ?? DEFAULT_RELAY_ENDPOINT,
    appBaseUrl: env.PASEO_APP_BASE_URL ?? DEFAULT_APP_BASE_URL,
    openai: parseOpenAIConfig(env),
  };
}
