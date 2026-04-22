import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pino from "pino";

import { AgentManager } from "../src/server/agent/agent-manager.js";
import { AgentStorage } from "../src/server/agent/agent-storage.js";
import { buildProviderRegistry, shutdownProviders } from "../src/server/agent/provider-registry.js";
import type {
  AgentProvider,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../src/server/agent/agent-sdk-types.js";
import { buildVoiceAgentMcpServerConfig } from "../src/server/session.js";
import { createAgentMcpServer } from "../src/server/agent/mcp-server.js";
import { createVoiceMcpSocketBridgeManager } from "../src/server/voice-mcp-bridge.js";
import { withTimeout } from "../src/utils/promise-timeout.js";

type CliOptions = {
  provider: AgentProvider;
  model?: string;
  timeoutMs: number;
};

function parseArgs(argv: string[]): CliOptions {
  let provider: AgentProvider = "claude";
  let model: string | undefined;
  let timeoutMs = 120_000;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--provider" && argv[i + 1]) {
      provider = argv[i + 1] as AgentProvider;
      i += 1;
      continue;
    }
    if (arg === "--model" && argv[i + 1]) {
      model = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--timeout-ms" && argv[i + 1]) {
      timeoutMs = Number(argv[i + 1]) || timeoutMs;
      i += 1;
    }
  }

  return { provider, model, timeoutMs };
}

async function streamWithTimeout(
  iterator: AsyncGenerator<AgentStreamEvent>,
  timeoutMs: number,
  onEvent: (event: AgentStreamEvent) => Promise<void> | void,
): Promise<void> {
  const consume = (async () => {
    for await (const event of iterator) {
      await onEvent(event);
    }
  })();

  await withTimeout(consume, timeoutMs, `Timed out after ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const logger = pino({ level: "info" });
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const serverDir = path.resolve(scriptDir, "..");
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-voice-mcp-smoke-"));
  const paseoHome = path.join(tmpRoot, ".paseo");
  const storageDir = path.join(paseoHome, "agents");
  const voiceBridgeRuntimeDir = path.join(tmpRoot, "voice-mcp");
  const voiceWorkspace = path.join(tmpRoot, "voice-agent-workspace");
  await mkdir(voiceWorkspace, { recursive: true });

  const providerRegistry = buildProviderRegistry(logger);
  const providerDefinition = providerRegistry[opts.provider];
  if (!providerDefinition) {
    throw new Error(`Unsupported provider: ${opts.provider}`);
  }

  const agentStorage = new AgentStorage(storageDir, logger);
  const agentManager = new AgentManager({
    logger,
    registry: agentStorage,
    clients: {
      [opts.provider]: providerDefinition.createClient(logger),
    },
  });

  const speakCalls: string[] = [];
  const resolveSpeakHandler = (callerAgentId: string) => {
    return async ({ text }: { text: string; callerAgentId: string }) => {
      speakCalls.push(text);
      logger.info({ callerAgentId, text }, "Smoke speak handler invoked");
    };
  };

  const voiceBridgeManager = createVoiceMcpSocketBridgeManager({
    runtimeDir: voiceBridgeRuntimeDir,
    logger,
    createAgentMcpServerForCaller: async (callerAgentId) => {
      return createAgentMcpServer({
        agentManager,
        agentStorage,
        paseoHome,
        callerAgentId,
        enableVoiceTools: false,
        resolveSpeakHandler,
        resolveCallerContext: () => ({
          childAgentDefaultLabels: { source: "voice-smoke" },
          allowCustomCwd: true,
          enableVoiceTools: true,
        }),
        logger,
      });
    },
  });

  const agentId = randomUUID();
  const socketPath = await voiceBridgeManager.ensureBridgeForCaller(agentId);
  const bridgeScriptPath = path.resolve(serverDir, "scripts/mcp-stdio-socket-bridge-cli.mjs");
  const config: AgentSessionConfig = {
    provider: opts.provider,
    cwd: voiceWorkspace,
    modeId: "default",
    ...(opts.model ? { model: opts.model } : {}),
    mcpServers: {
      paseo: buildVoiceAgentMcpServerConfig({
        command: process.execPath,
        baseArgs: [bridgeScriptPath],
        socketPath,
        env: {
          PASEO_HOME: paseoHome,
        },
      }),
    },
  };

  const prompt = [
    "You must call the MCP tool named speak.",
    "Call it exactly once with this exact text: BRIDGE_SMOKE_OK",
    "Do not call any other tools.",
    "After the tool call, end your response.",
  ].join("\n");

  let sawSpeakTimeline = false;
  let sawTurnFailed = false;
  let failureError: string | null = null;

  try {
    const created = await agentManager.createAgent(config, agentId, {
      labels: { surface: "voice-smoke" },
    });
    logger.info({ provider: opts.provider, agentId: created.id }, "Created smoke agent");

    const iterator = agentManager.streamAgent(created.id, prompt);
    await streamWithTimeout(iterator, opts.timeoutMs, async (event) => {
      if (event.type === "permission_requested") {
        await agentManager.respondToPermission(created.id, event.request.id, { behavior: "allow" });
      }
      if (event.type === "turn_failed") {
        sawTurnFailed = true;
        failureError = event.error;
      }
      if (event.type === "timeline" && event.item.type === "tool_call") {
        logger.info({ name: event.item.name, callId: event.item.callId }, "Timeline tool call");
        if (
          typeof event.item.name === "string" &&
          event.item.name.toLowerCase().includes("speak")
        ) {
          sawSpeakTimeline = true;
        }
      }
    });

    console.log(
      JSON.stringify(
        {
          ok: !sawTurnFailed && sawSpeakTimeline && speakCalls.length > 0,
          provider: opts.provider,
          agentId,
          sawSpeakTimeline,
          speakCalls,
          sawTurnFailed,
          failureError,
        },
        null,
        2,
      ),
    );
  } finally {
    await agentManager.closeAgent(agentId).catch(() => undefined);
    await agentManager.flush().catch(() => undefined);
    await voiceBridgeManager.stop().catch(() => undefined);
    await shutdownProviders(logger).catch(() => undefined);
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
