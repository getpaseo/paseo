import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "pino";

import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import {
  JSONL_RPC_NO_TIMEOUT,
  JsonlRpcProcess,
  type JsonlRpcLaunch,
} from "../jsonl-rpc-process.js";
import {
  buildPiLaunch,
  type PiRuntime,
  type PiRuntimeLaunch,
  type PiRuntimeSession,
  type PiStartSessionInput,
} from "./runtime.js";
import type {
  PiAgentMessage,
  PiModel,
  PiPromptAck,
  PiRpcCommand,
  PiRpcSlashCommand,
  PiRuntimeEvent,
  PiSessionState,
  PiSessionStats,
} from "./rpc-types.js";

const DEFAULT_PI_COMMAND: [string, ...string[]] = [
  process.env.PI_COMMAND ?? process.env.PI_ACP_PI_COMMAND ?? "pi",
];
const DEFAULT_COMMANDS_RPC_NAME = "get_commands";

/**
 * Pi RPC timeout policy:
 * - Control-plane / accept-and-stream (`prompt`, `get_state`, `abort`, …): default 30s
 * - Long-running blocking LLM jobs (`compact`): no wall-clock timeout — complete on
 *   response, process death, or session close (`JsonlRpcProcess.failAll` / `close`).
 */
const PI_COMPACT_REQUEST_TIMEOUT_MS = JSONL_RPC_NO_TIMEOUT;

export interface PiCliRuntimeOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  command?: [string, ...string[]];
  commandsRpcName?: string;
  spawnProcess?: (launch: PiRuntimeLaunch) => ChildProcessWithoutNullStreams;
}

export class PiCliRuntime implements PiRuntime {
  private readonly command: [string, ...string[]];
  private readonly commandsRpcName: string;
  private readonly spawnProcess?: (launch: PiRuntimeLaunch) => ChildProcessWithoutNullStreams;

  constructor(private readonly options: PiCliRuntimeOptions) {
    this.command = options.command ?? DEFAULT_PI_COMMAND;
    this.commandsRpcName = options.commandsRpcName ?? DEFAULT_COMMANDS_RPC_NAME;
    this.spawnProcess = options.spawnProcess;
  }

  async startSession(input: PiStartSessionInput): Promise<PiRuntimeSession> {
    const launch = buildPiLaunch({
      command: this.command,
      runtimeSettings: this.options.runtimeSettings,
      session: input,
    });
    const [command, ...args] = launch.argv;
    const processLaunch: JsonlRpcLaunch = {
      command,
      args,
      cwd: launch.cwd,
      env: launch.env,
    };
    const spawn = this.spawnProcess;
    const processOptions = {
      launch: processLaunch,
      logger: this.options.logger,
      diagnosticName: "Pi RPC",
      ...(spawn ? { spawn: () => spawn(launch) } : {}),
    };
    const process = new JsonlRpcProcess(processOptions);
    return new PiCliRuntimeSession(process, this.commandsRpcName);
  }
}

class PiCliRuntimeSession implements PiRuntimeSession {
  private readonly subscribers = new Set<(event: PiRuntimeEvent) => void>();

  constructor(
    private readonly process: JsonlRpcProcess,
    private readonly commandsRpcName: string,
  ) {
    process.onMessage((message) => {
      this.emit(message as PiRuntimeEvent);
    });
    process.onExit(({ error }) => {
      this.emit({ type: "process_exit", error: error.message });
    });
  }

  onEvent(callback: (event: PiRuntimeEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async prompt(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<PiPromptAck> {
    const { id: requestId, promise } = this.process.startRequest({
      type: "prompt",
      message,
      ...(images?.length ? { images } : {}),
    });
    const data = await promise;
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      const { agentInvoked } = data as Record<string, unknown>;
      if (typeof agentInvoked === "boolean") {
        return { requestId, agentInvoked };
      }
    }
    return { requestId };
  }

  async compact(customInstructions?: string): Promise<void> {
    // Compact is a blocking LLM summarization job; Pi only returns the RPC
    // response after the summary is written. A control-plane 30s timeout falsely
    // fails long sessions while the real compact continues (issue #1946).
    await this.request(
      {
        type: "compact",
        ...(customInstructions ? { customInstructions } : {}),
      },
      PI_COMPACT_REQUEST_TIMEOUT_MS,
    );
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.request({ type: "set_auto_compaction", enabled });
  }

  async abort(): Promise<void> {
    await this.request({ type: "abort" });
  }

  async getState(): Promise<PiSessionState> {
    return (await this.request({ type: "get_state" })) as PiSessionState;
  }

  async getMessages(): Promise<PiAgentMessage[]> {
    const data = (await this.request({ type: "get_messages" })) as { messages?: PiAgentMessage[] };
    return data.messages ?? [];
  }

  async getAvailableModels(timeoutMs?: number | null): Promise<PiModel[]> {
    const data = (await this.request({ type: "get_available_models" }, timeoutMs)) as {
      models?: PiModel[];
    };
    return data.models ?? [];
  }

  async setModel(provider: string, modelId: string): Promise<PiModel> {
    return (await this.request({ type: "set_model", provider, modelId })) as PiModel;
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.request({ type: "set_thinking_level", level: level as never });
  }

  async getSessionStats(): Promise<PiSessionStats> {
    // COMPAT(piGetStateFallback): added in v0.1.105 — older Oh My Pi binaries
    // lack the `get_session_stats` RPC command; fall back to extracting
    // context window usage from `get_state`. Remove after 2027-01-10 once the
    // supported Oh My Pi floor includes `get_session_stats`.
    let stats: PiSessionStats | undefined;
    try {
      stats = (await this.request({ type: "get_session_stats" })) as PiSessionStats;
    } catch {
      // get_session_stats not supported by this binary — will try get_state below
    }
    if (stats?.tokens == null && stats?.cost == null && stats?.contextUsage == null) {
      try {
        const state = (await this.request({ type: "get_state" })) as Record<string, unknown>;
        const ctx = state.contextUsage as
          | { tokens?: number | null; contextWindow?: number | null }
          | undefined;
        if (ctx) {
          return {
            contextUsage: {
              tokens: typeof ctx.tokens === "number" ? ctx.tokens : undefined,
              contextWindow: typeof ctx.contextWindow === "number" ? ctx.contextWindow : undefined,
            },
          };
        }
      } catch {
        // get_state also failed — nothing we can do
      }
    }
    return stats ?? {};
  }

  async getCommands(): Promise<PiRpcSlashCommand[]> {
    const data = (await this.request({ type: this.commandsRpcName })) as {
      commands?: PiRpcSlashCommand[];
    };
    return data.commands ?? [];
  }

  sendRawFrame(frame: object & { type: string }): void {
    this.process.send(frame);
  }

  respondToExtensionUiRequest(
    id: string,
    response: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ): void {
    this.process.send({ type: "extension_ui_response", id, ...response });
  }

  cancelExtensionUiRequest(id: string): void {
    this.respondToExtensionUiRequest(id, { cancelled: true });
  }

  async close(): Promise<void> {
    await this.process.close(new Error("Pi RPC session is closed"));
  }

  request(command: PiRpcCommand, timeoutMs?: number | null): Promise<unknown> {
    return this.process.request(command, timeoutMs);
  }

  private emit(event: PiRuntimeEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}
