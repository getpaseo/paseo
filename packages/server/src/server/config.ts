import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";

import type { PaseoDaemonConfig } from "./bootstrap.js";
import type { STTConfig } from "./agent/stt-openai.js";
import type { TTSConfig } from "./agent/tts-openai.js";

function expandHomeDir(input: string): string {
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  if (input === "~") {
    return os.homedir();
  }
  return input;
}

export function readPaseoHomeFromEnv(
  env: NodeJS.ProcessEnv = process.env
): string {
  const raw = env.PASEO_HOME ?? env.PASEO_HOME_DIR ?? "~/.paseo";
  const expanded = path.resolve(expandHomeDir(raw));
  mkdirSync(expanded, { recursive: true });
  return expanded;
}

export function readPaseoPortFromEnv(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.PASEO_PORT ?? env.PORT ?? "6767";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 6767;
}

const DEFAULT_BASIC_AUTH_USERS = { mo: "bo" } as const;
const DEFAULT_AGENT_MCP_ROUTE = "/mcp/agents";

function readOpenAIConfigFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    return undefined;
  }

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

export function buildPaseoDaemonConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): PaseoDaemonConfig {
  const paseoHome = readPaseoHomeFromEnv(env);
  const port = readPaseoPortFromEnv(env);

  const basicUsers = DEFAULT_BASIC_AUTH_USERS;
  const [agentMcpUser, agentMcpPassword] =
    Object.entries(basicUsers)[0] ?? [];
  const agentMcpAuthHeader =
    agentMcpUser && agentMcpPassword
      ? `Basic ${Buffer.from(`${agentMcpUser}:${agentMcpPassword}`).toString("base64")}`
      : undefined;
  const agentMcpBearerToken =
    agentMcpUser && agentMcpPassword
      ? Buffer.from(`${agentMcpUser}:${agentMcpPassword}`).toString("base64")
      : undefined;

  const openai = readOpenAIConfigFromEnv(env);

  return {
    port,
    paseoHome,
    agentMcpRoute: DEFAULT_AGENT_MCP_ROUTE,
    agentMcpAllowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
    auth: {
      basicUsers,
      agentMcpAuthHeader,
      agentMcpBearerToken,
      realm: "Voice Assistant",
    },
    mcpDebug: env.MCP_DEBUG === "1",
    agentControlMcp: {
      url: `http://127.0.0.1:${port}${DEFAULT_AGENT_MCP_ROUTE}`,
      ...(agentMcpAuthHeader
        ? { headers: { Authorization: agentMcpAuthHeader } }
        : {}),
    },
    agentRegistryPath: path.join(paseoHome, "agents.json"),
    staticDir: "public",
    agentClients: {},
    openai,
  };
}
