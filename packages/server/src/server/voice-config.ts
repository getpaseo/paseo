import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSelfNodeCommand } from "./paseo-env.js";

const VOICE_PROMPT_BLOCK_START = "<paseo_voice_mode>";
const VOICE_PROMPT_BLOCK_END = "</paseo_voice_mode>";
const PASEO_SERVER_PACKAGE_NAME = "@getpaseo/server";

export const PASEO_VOICE_MCP_SERVER_NAME = "paseo_voice";
const PASEO_VOICE_ENABLED_TOOLS = ["speak"] as const;

function resolveVoiceSpeakToolName(voiceToolMcpServerName?: string): string {
  return voiceToolMcpServerName ? `${voiceToolMcpServerName}.speak` : "speak";
}

function buildEnabledVoiceAgentSystemInstruction(voiceToolMcpServerName?: string): string {
  const speakToolName = resolveVoiceSpeakToolName(voiceToolMcpServerName);
  return [
    "Paseo voice mode is now on.",
    "You are the Paseo voice assistant.",
    "The user cannot see your chat messages or tool calls.",
    `Always use the ${speakToolName} tool for all user-facing communication.`,
    `Before calling any non-speech tool, first call ${speakToolName} with a short acknowledgement of what you heard and what you will do next.`,
    `For long-running work, use ${speakToolName} to provide progress updates before and during execution.`,
    "Treat the user input as transcribed speech.",
    "If the user intent is clear, proceed without extra confirmation.",
    `If the transcription seems incomplete, cut off, ambiguous, or may contain a non-obvious mistake or misspelling, ask a clarifying question via ${speakToolName} before taking action.`,
    "Use concise plain language suitable for speech output.",
  ].join(" ");
}

const VOICE_AGENT_DISABLED_INSTRUCTION = [
  "Paseo voice mode is now off.",
  "Ignore any earlier Paseo voice mode instructions in this thread.",
].join(" ");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeVoicePromptBlockRegex(): RegExp {
  return new RegExp(
    `${escapeRegExp(VOICE_PROMPT_BLOCK_START)}[\\s\\S]*?${escapeRegExp(VOICE_PROMPT_BLOCK_END)}`,
    "g",
  );
}

export function stripVoiceModeSystemPrompt(existing?: string): string | undefined {
  const trimmed = existing?.trim();
  if (!trimmed) {
    return undefined;
  }
  const stripped = trimmed.replace(makeVoicePromptBlockRegex(), "").trim();
  return stripped.length > 0 ? stripped : undefined;
}

export function buildVoiceModeSystemPrompt(
  existing: string | undefined,
  enabled: boolean,
  options?: { voiceToolMcpServerName?: string },
): string {
  const basePrompt = stripVoiceModeSystemPrompt(existing);
  const voiceInstruction = enabled
    ? buildEnabledVoiceAgentSystemInstruction(options?.voiceToolMcpServerName)
    : VOICE_AGENT_DISABLED_INSTRUCTION;
  const voiceBlock = [VOICE_PROMPT_BLOCK_START, voiceInstruction, VOICE_PROMPT_BLOCK_END].join(
    "\n",
  );

  return [basePrompt, voiceBlock]
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .join("\n\n");
}

export function wrapSpokenInput(
  text: string,
  options?: { voiceToolMcpServerName?: string },
): string {
  const speakToolName = resolveVoiceSpeakToolName(options?.voiceToolMcpServerName);
  return `<spoken-input>\n${text}\n</spoken-input>\n<instruction>This message was spoken by the user. Respond using the ${speakToolName} tool only, not normal messages, because the user may not be looking at the chat.</instruction>`;
}

export function buildVoiceAgentMcpServerConfig(params: {
  command: string;
  baseArgs: string[];
  socketPath: string;
  env?: Record<string, string>;
}): import("./agent/agent-sdk-types.js").McpStdioServerConfig {
  return {
    type: "stdio",
    command: params.command,
    args: [...params.baseArgs, "--socket", params.socketPath],
    enabledTools: [...PASEO_VOICE_ENABLED_TOOLS],
    defaultToolsApprovalMode: "prompt",
    tools: {
      speak: { approvalMode: "approve" },
    },
    ...(params.env ? { env: params.env } : {}),
  };
}

export function resolveVoiceAgentBridgeSocketPath(
  listen: string | null | undefined,
): string | null {
  const trimmed = listen?.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("\\\\.\\pipe\\")) {
    return trimmed;
  }
  if (trimmed.startsWith("pipe://")) {
    return trimmed.slice("pipe://".length);
  }
  if (trimmed.startsWith("unix://")) {
    return trimmed.slice("unix://".length);
  }
  if (trimmed.startsWith("~/")) {
    return path.join(homedir(), trimmed.slice(2));
  }
  if (trimmed === "~") {
    return homedir();
  }
  if (trimmed.startsWith("/")) {
    return trimmed;
  }
  return null;
}

export function resolveVoiceAgentBridgeScriptPath(
  moduleUrl: string = import.meta.url,
): string | null {
  const packageRoot = resolvePackageRootFrom(fileURLToPath(moduleUrl), PASEO_SERVER_PACKAGE_NAME);
  if (!packageRoot) {
    return null;
  }

  const bundledPath = path.join(packageRoot, "dist", "scripts", "mcp-stdio-socket-bridge-cli.mjs");
  if (existsSync(bundledPath)) {
    return bundledPath;
  }

  const sourcePath = path.join(packageRoot, "scripts", "mcp-stdio-socket-bridge-cli.mjs");
  return existsSync(sourcePath) ? sourcePath : null;
}

export function buildDedicatedVoiceAgentMcpServerConfig(params: {
  mcpBaseUrl?: string | null;
  callerAgentId?: string | null;
  mcpAuthToken?: string | null;
  listen: string | null | undefined;
  paseoHome: string;
  moduleUrl?: string;
}):
  | {
      type: "http";
      url: string;
      headers?: Record<string, string>;
      enabledTools?: string[];
      defaultToolsApprovalMode?: "auto" | "prompt" | "approve";
      tools?: Record<string, { approvalMode?: "auto" | "prompt" | "approve" }>;
    }
  | import("./agent/agent-sdk-types.js").McpStdioServerConfig
  | null {
  const callerAgentId = params.callerAgentId?.trim();
  if (params.mcpBaseUrl && callerAgentId) {
    const url = new URL(params.mcpBaseUrl);
    url.searchParams.set("callerAgentId", callerAgentId);
    url.searchParams.set("voiceOnly", "1");
    return {
      type: "http",
      url: url.toString(),
      enabledTools: [...PASEO_VOICE_ENABLED_TOOLS],
      defaultToolsApprovalMode: "prompt",
      tools: {
        speak: { approvalMode: "approve" },
      },
      ...(params.mcpAuthToken
        ? { headers: { Authorization: `Bearer ${params.mcpAuthToken}` } }
        : {}),
    };
  }

  const socketPath = resolveVoiceAgentBridgeSocketPath(params.listen);
  if (!socketPath) {
    return null;
  }

  const bridgeScriptPath = resolveVoiceAgentBridgeScriptPath(params.moduleUrl);
  if (!bridgeScriptPath) {
    return null;
  }

  const selfCommand = buildSelfNodeCommand([bridgeScriptPath], {
    PASEO_HOME: params.paseoHome,
  });

  return buildVoiceAgentMcpServerConfig({
    command: selfCommand.command,
    baseArgs: selfCommand.args,
    socketPath,
    env: selfCommand.env,
  });
}

function resolvePackageRootFrom(startPath: string, packageName: string): string | null {
  let currentDir = path.dirname(startPath);

  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
        if (packageJson.name === packageName) {
          return currentDir;
        }
      } catch {
        return null;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}
