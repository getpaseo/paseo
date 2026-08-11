import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "pino";

import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import {
  JSONL_RPC_DEFAULT_TIMEOUT_MS,
  JsonlRpcProcess,
  type JsonlRpcLaunch,
} from "../jsonl-rpc-process.js";
import {
  buildOmpLaunch,
  type OmpRuntime,
  type OmpRuntimeLaunch,
  type OmpRuntimeSession,
  type OmpStartSessionInput,
} from "./runtime.js";
import {
  OmpBranchMessagesResultSchema,
  OmpBranchResultSchema,
  OmpCommandsResultSchema,
  OmpHostToolsResultSchema,
  OmpMessagesResultSchema,
  OmpModelSchema,
  OmpModelsResultSchema,
  OmpPromptAckSchema,
  OmpRpcCommandSchema,
  OmpRuntimeEventSchema,
  OmpSessionStateSchema,
  OmpSessionStatsSchema,
  type OmpThinkingLevel,
  type OmpAgentMessage,
  type OmpModel,
  type OmpPromptAck,
  type OmpRpcCommand,
  type OmpRpcHostToolDefinition,
  type OmpRpcHostToolResult,
  type OmpRpcHostToolUpdate,
  type OmpRpcSlashCommand,
  type OmpRuntimeEvent,
  type OmpSessionState,
  type OmpSessionStats,
  type OmpSubagentSubscriptionLevel,
} from "./rpc-types.js";

const DEFAULT_OMP_COMMAND: [string, ...string[]] = [process.env.OMP_COMMAND ?? "omp"];
const DEFAULT_COMMANDS_RPC_NAME = "get_available_commands";
/** How long to wait for OMP's startup `ready` frame before assuming protocol v1. */
const OMP_READY_TIMEOUT_MS = 10_000;

export interface OmpCliRuntimeOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  command?: [string, ...string[]];
  commandsRpcName?: "get_available_commands";
  spawnProcess?: (launch: OmpRuntimeLaunch) => ChildProcessWithoutNullStreams;
}

export class OmpCliRuntime implements OmpRuntime {
  private readonly command: [string, ...string[]];
  private readonly commandsRpcName: "get_available_commands";
  private readonly spawnProcess?: (launch: OmpRuntimeLaunch) => ChildProcessWithoutNullStreams;

  constructor(private readonly options: OmpCliRuntimeOptions) {
    this.command = options.command ?? DEFAULT_OMP_COMMAND;
    this.commandsRpcName = options.commandsRpcName ?? DEFAULT_COMMANDS_RPC_NAME;
    this.spawnProcess = options.spawnProcess;
  }

  async startSession(input: OmpStartSessionInput): Promise<OmpRuntimeSession> {
    const launch = buildOmpLaunch({
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
      diagnosticName: "OMP RPC",
      ...(spawn ? { spawn: () => spawn(launch) } : {}),
    };
    const process = new JsonlRpcProcess(processOptions);
    await negotiateOmpProtocolV2(process, this.options.logger);
    return new OmpCliRuntimeSession(process, this.commandsRpcName);
  }
}

/**
 * Wait for OMP to advertise readiness and negotiate RPC protocol v2 when it is
 * supported. OMP caps protocol-v1 single-line frames at 1 MiB; `get_available_models`
 * (and other large payloads) can exceed that and are returned as an overflow error.
 * Protocol v2 lifts the ceiling to 64 MiB by chunking oversized frames, which the
 * JSONL transport reassembles. Modern OMP always sends a `ready` frame immediately
 * after launch; if none arrives (very old binaries) we proceed on protocol v1.
 */
async function negotiateOmpProtocolV2(process: JsonlRpcProcess, logger: Logger): Promise<void> {
  const ready = await waitForOmpReadyFrame(process);
  const supported = ready?.supportedProtocolVersions;
  if (!Array.isArray(supported) || !supported.includes(2)) {
    return;
  }
  try {
    const response = (await process.request(
      { type: "negotiate_protocol", protocolVersion: 2 },
      JSONL_RPC_DEFAULT_TIMEOUT_MS,
    )) as { protocolVersion?: unknown } | undefined;
    if (response?.protocolVersion === 2) {
      logger.debug({}, "Negotiated OMP RPC protocol v2 (chunked frame transport)");
    } else {
      logger.warn({ response }, "OMP did not accept RPC protocol v2; continuing on protocol v1");
    }
  } catch (error) {
    logger.warn({ error }, "OMP RPC protocol v2 negotiation failed; continuing on protocol v1");
  }
}

function waitForOmpReadyFrame(
  process: JsonlRpcProcess,
): Promise<Record<string, unknown> | undefined> {
  const ready = new Promise<Record<string, unknown>>((resolve) => {
    const unsubscribe = process.onMessage((message) => {
      if (message.type === "ready") {
        unsubscribe();
        resolve(message);
      }
    });
  });
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), OMP_READY_TIMEOUT_MS);
  });
  void ready.finally(() => {
    if (timer !== null) {
      clearTimeout(timer);
    }
  });
  return Promise.race([ready, timeout]);
}

class OmpCliRuntimeSession implements OmpRuntimeSession {
  private readonly subscribers = new Set<(event: OmpRuntimeEvent) => void>();
  activeBranchEntryId?: string;

  constructor(
    private readonly process: JsonlRpcProcess,
    private readonly commandsRpcName: "get_available_commands",
  ) {
    process.onMessage((message) => {
      const event = OmpRuntimeEventSchema.safeParse(message);
      if (event.success) {
        this.emit(event.data);
      }
    });
    process.onExit(({ error }) => {
      this.emit({ type: "process_exit", error: error.message });
    });
  }

  onEvent(callback: (event: OmpRuntimeEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async prompt(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<OmpPromptAck> {
    const { id: requestId, promise } = this.process.startRequest({
      type: "prompt",
      message,
      ...(images?.length ? { images } : {}),
    });
    const ack = OmpPromptAckSchema.parse(await promise) ?? {};
    return { requestId, ...ack };
  }

  async compact(customInstructions?: string): Promise<void> {
    await this.request({
      type: "compact",
      ...(customInstructions ? { customInstructions } : {}),
    });
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.request({ type: "set_auto_compaction", enabled });
  }

  async abort(): Promise<void> {
    await this.request({ type: "abort" });
  }

  async getState(): Promise<OmpSessionState> {
    return OmpSessionStateSchema.parse(await this.request({ type: "get_state" }));
  }

  async getMessages(): Promise<OmpAgentMessage[]> {
    const data = OmpMessagesResultSchema.parse(await this.request({ type: "get_messages" }));
    return data.messages ?? [];
  }

  async getAvailableModels(timeoutMs?: number): Promise<OmpModel[]> {
    const data = OmpModelsResultSchema.parse(
      await this.request({ type: "get_available_models" }, timeoutMs),
    );
    return data.models ?? [];
  }

  async setModel(provider: string, modelId: string): Promise<OmpModel> {
    return OmpModelSchema.parse(await this.request({ type: "set_model", provider, modelId }));
  }

  async setThinkingLevel(level: OmpThinkingLevel): Promise<void> {
    await this.request({ type: "set_thinking_level", level });
  }

  async getSessionStats(): Promise<OmpSessionStats> {
    // COMPAT(ompGetStateFallback): added in v0.1.105 — older OMP binaries
    // lack the `get_session_stats` RPC command; fall back to extracting
    // context window usage from `get_state`. Remove after 2027-01-10 once the
    // supported OMP floor includes `get_session_stats`.
    let stats: OmpSessionStats | undefined;
    try {
      stats = OmpSessionStatsSchema.parse(await this.request({ type: "get_session_stats" }));
    } catch {
      // get_session_stats not supported by this binary — will try get_state below
    }
    if (stats?.tokens == null && stats?.cost == null && stats?.contextUsage == null) {
      try {
        const state = OmpSessionStateSchema.parse(await this.request({ type: "get_state" }));
        const ctx = state.contextUsage;
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

  async getCommands(): Promise<OmpRpcSlashCommand[]> {
    const data = OmpCommandsResultSchema.parse(await this.request({ type: this.commandsRpcName }));
    return data.commands ?? [];
  }

  async setSubagentSubscription(level: OmpSubagentSubscriptionLevel): Promise<void> {
    await this.request({ type: "set_subagent_subscription", level });
  }

  async setHostTools(tools: OmpRpcHostToolDefinition[]): Promise<string[]> {
    const data = OmpHostToolsResultSchema.parse(
      await this.request({ type: "set_host_tools", tools }),
    );
    return data.toolNames ?? [];
  }

  sendHostToolResult(result: OmpRpcHostToolResult): void {
    this.process.send({ ...result });
  }

  sendHostToolUpdate(update: OmpRpcHostToolUpdate): void {
    this.process.send({ ...update });
  }

  async branch(entryId: string): Promise<{ text: string }> {
    const data = OmpBranchResultSchema.parse(await this.request({ type: "branch", entryId }));
    if (data.cancelled === true) {
      throw new Error("OMP branch was cancelled");
    }
    if (typeof data.text !== "string") {
      throw new Error("OMP branch response did not include restored prompt text");
    }
    this.activeBranchEntryId = entryId;
    return { text: data.text };
  }

  async getBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
    const data = OmpBranchMessagesResultSchema.parse(
      await this.request({ type: "get_branch_messages" }),
    );
    return data.messages ?? [];
  }

  steer(message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): void {
    this.process.send({ type: "steer", message, ...(images?.length ? { images } : {}) });
  }

  followUp(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): void {
    this.process.send({ type: "follow_up", message, ...(images?.length ? { images } : {}) });
  }

  async handoff(customInstructions?: string): Promise<void> {
    await this.request({
      type: "handoff",
      ...(customInstructions ? { customInstructions } : {}),
    });
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
    await this.process.close(new Error("OMP RPC session is closed"));
  }

  private request(command: OmpRpcCommand, timeoutMs?: number): Promise<unknown> {
    return this.process.request(OmpRpcCommandSchema.parse(command), timeoutMs);
  }

  private emit(event: OmpRuntimeEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}
