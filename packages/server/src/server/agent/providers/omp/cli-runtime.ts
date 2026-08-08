import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "pino";

import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { JsonlRpcProcess, type JsonlRpcLaunch } from "../jsonl-rpc-process.js";
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
const OMP_READY_TIMEOUT_MS = 30_000;
const OMP_MAX_FRAME_BYTES = 1024 * 1024;
const OMP_MAX_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function supportsOmpProtocolV2(ready: Record<string, unknown>): boolean {
  return (
    ready.type === "ready" &&
    Array.isArray(ready.supportedProtocolVersions) &&
    ready.supportedProtocolVersions.some((version) => version === 2) &&
    ready.maxFrameBytes === OMP_MAX_FRAME_BYTES &&
    ready.maxReassembledFrameBytes === OMP_MAX_REASSEMBLED_FRAME_BYTES
  );
}

function confirmsOmpProtocolV2(response: unknown): boolean {
  if (
    !isRecord(response) ||
    response.type !== "response" ||
    response.command !== "negotiate_protocol" ||
    response.success !== true ||
    !isRecord(response.data)
  ) {
    return false;
  }
  return response.data.protocolVersion === 2;
}

async function awaitOmpReady(process: JsonlRpcProcess): Promise<Record<string, unknown>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      process.awaitReady(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for OMP RPC ready frame")),
          OMP_READY_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

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
    try {
      // Construct the session before the startup gate so its onMessage
      // listener is registered before any post-ready frame is read. A valid
      // provider event that shares the same stdout chunk as the negotiation
      // response is buffered by the session and replayed once a consumer
      // subscribes, instead of being lost before the session existed.
      const session = new OmpCliRuntimeSession(process, this.commandsRpcName, {
        deferEvents: true,
      });
      const ready = await awaitOmpReady(process);
      if (supportsOmpProtocolV2(ready)) {
        // OMP can emit a post-negotiation frame in the same stdout chunk as its
        // acknowledgement. Prime decoding before the request so that frame is
        // never processed as an unnegotiated rpc_chunk; a usable v2 session is
        // still returned only after the response confirms protocol version 2.
        process.enableChunkDecoder();
        const response = await process.requestResponse({
          type: "negotiate_protocol",
          protocolVersion: 2,
        });
        if (!confirmsOmpProtocolV2(response)) {
          throw new Error("OMP RPC protocol v2 negotiation failed");
        }
      }
      return session;
    } catch (error) {
      const startupError = error instanceof Error ? error : new Error(String(error));
      await process.close(startupError);
      throw startupError;
    }
  }
}

class OmpCliRuntimeSession implements OmpRuntimeSession {
  private readonly subscribers = new Set<(event: OmpRuntimeEvent) => void>();
  private readonly deferredEvents: OmpRuntimeEvent[] = [];
  private deferringEvents: boolean;
  activeBranchEntryId?: string;

  constructor(
    private readonly process: JsonlRpcProcess,
    private readonly commandsRpcName: "get_available_commands",
    options?: { deferEvents?: boolean },
  ) {
    // When the runtime constructs the session before the OMP v2 negotiation
    // round-trip completes, a valid provider event coalesced onto the same
    // stdout chunk as the negotiation response would otherwise be dropped
    // before any `onEvent` subscriber exists. Buffer such events and replay
    // them in arrival order once the first subscriber registers.
    this.deferringEvents = options?.deferEvents ?? false;
    process.onMessage((message) => {
      const event = OmpRuntimeEventSchema.safeParse(message);
      if (!event.success) {
        return;
      }
      if (this.deferringEvents) {
        this.deferredEvents.push(event.data);
      } else {
        this.emit(event.data);
      }
    });
    process.onExit(({ error }) => {
      this.emit({ type: "process_exit", error: error.message });
    });
  }

  onEvent(callback: (event: OmpRuntimeEvent) => void): () => void {
    this.subscribers.add(callback);
    if (this.deferringEvents) {
      this.deferringEvents = false;
      const replay = this.deferredEvents.splice(0);
      for (const event of replay) {
        callback(event);
      }
    }
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
