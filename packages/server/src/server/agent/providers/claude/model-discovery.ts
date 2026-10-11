import type { ChildProcess } from "node:child_process";
import os from "node:os";
import type { ModelInfo, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { raceProviderRefreshAbort } from "../../provider-refresh-deadline.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { terminateWithTreeKill } from "../../../../utils/tree-kill.js";
import { claudeQuery, type ClaudeQueryInput, type ClaudeQueryContext } from "./query.js";

interface ClaudeModelDiscoveryOptions {
  resolveBinary: () => Promise<string>;
  runtimeSettings?: ProviderRuntimeSettings;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

type OpenDiscoveryQuery = (
  input: ClaudeQueryInput,
  context: ClaudeQueryContext,
) => Pick<Query, "supportedModels" | "close">;

// The curated catalog survives a failed or slow probe. This process never receives
// a prompt and must not persist a session or launch user MCP servers/hooks.
export async function discoverClaudeModels(
  options: ClaudeModelDiscoveryOptions,
  openQuery: OpenDiscoveryQuery = claudeQuery,
): Promise<ModelInfo[]> {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(
    () => controller.abort(new Error("Claude model discovery timed out")),
    5_000,
  );
  let endInput!: () => void;
  const ended = new Promise<void>((resolve) => {
    endInput = resolve;
  });
  const input: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          await ended;
          return { done: true, value: undefined };
        },
      };
    },
  };
  let query: ReturnType<OpenDiscoveryQuery> | undefined;
  let child: ChildProcess | undefined;
  try {
    signal.throwIfAborted();
    const binary = await raceProviderRefreshAbort(signal, options.resolveBinary());
    query = openQuery(
      {
        prompt: input,
        options: {
          pathToClaudeCodeExecutable: binary,
          cwd: os.homedir(),
          env: options.env,
          persistSession: false,
          tools: [],
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: ["user"],
          settings: { disableAllHooks: true },
          abortController: controller,
        },
      },
      {
        runtimeSettings: options.runtimeSettings,
        onChildProcess: (process) => {
          child = process;
        },
      },
    );
    return await raceProviderRefreshAbort(signal, query.supportedModels());
  } finally {
    clearTimeout(timer);
    endInput();
    try {
      query?.close();
    } finally {
      if (child) {
        await terminateWithTreeKill(child, { gracefulTimeoutMs: 200, forceTimeoutMs: 200 });
      }
    }
  }
}
