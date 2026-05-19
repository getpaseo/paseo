import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "pino";

import { terminateWithTreeKill } from "../../../../utils/tree-kill.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
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
  PiRpcCommand,
  PiRpcResponse,
  PiRpcSlashCommand,
  PiRuntimeEvent,
  PiSessionState,
  PiSessionStats,
} from "./rpc-types.js";

const DEFAULT_PI_COMMAND: [string, ...string[]] = [
  process.env.PI_COMMAND ?? process.env.PI_ACP_PI_COMMAND ?? "pi",
];
const DEFAULT_TIMEOUT_MS = 30_000;
const STDERR_BUFFER_LIMIT = 8192;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2_000;
const FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface PiCliRuntimeOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  command?: [string, ...string[]];
  spawnProcess?: (launch: PiRuntimeLaunch) => ChildProcessWithoutNullStreams;
}

export class PiCliRuntime implements PiRuntime {
  private readonly command: [string, ...string[]];
  private readonly spawnProcess: (launch: PiRuntimeLaunch) => ChildProcessWithoutNullStreams;

  constructor(private readonly options: PiCliRuntimeOptions) {
    this.command = options.command ?? DEFAULT_PI_COMMAND;
    this.spawnProcess =
      options.spawnProcess ??
      ((launch) => {
        const [command, ...args] = launch.argv;
        return spawn(command, args, {
          cwd: launch.cwd,
          env: launch.env ? { ...process.env, ...launch.env } : process.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      });
  }

  async startSession(input: PiStartSessionInput): Promise<PiRuntimeSession> {
    const launch = buildPiLaunch({
      command: this.command,
      runtimeSettings: this.options.runtimeSettings,
      session: input,
    });
    return new PiCliRuntimeSession(launch, this.spawnProcess(launch), this.options.logger);
  }
}

class PiCliRuntimeSession implements PiRuntimeSession {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly subscribers = new Set<(event: PiRuntimeEvent) => void>();
  private stderrBuffer = "";
  private nextRequestId = 1;
  private disposed = false;
  private stdoutBuffer = "";

  constructor(
    _launch: PiRuntimeLaunch,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly logger: Logger,
  ) {
    child.stdout.on("data", (chunk) => {
      this.handleStdoutChunk(chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      this.stderrBuffer += chunk.toString();
      if (this.stderrBuffer.length > STDERR_BUFFER_LIMIT) {
        this.stderrBuffer = this.stderrBuffer.slice(-STDERR_BUFFER_LIMIT);
      }
    });
    child.on("error", (error) => {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    });
    child.on("exit", (code, signal) => {
      const error = new Error(
        `Pi RPC process exited with code ${code ?? "null"} and signal ${signal ?? "null"}\n${this.stderrBuffer}`.trim(),
      );
      this.emit({ type: "process_exit", error: error.message });
      this.failAll(error);
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
  ): Promise<void> {
    await this.request({ type: "prompt", message, ...(images?.length ? { images } : {}) });
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

  async getAvailableModels(): Promise<PiModel[]> {
    const data = (await this.request({ type: "get_available_models" })) as { models?: PiModel[] };
    return data.models ?? [];
  }

  async setModel(provider: string, modelId: string): Promise<PiModel> {
    return (await this.request({ type: "set_model", provider, modelId })) as PiModel;
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.request({ type: "set_thinking_level", level: level as never });
  }

  async getSessionStats(): Promise<PiSessionStats> {
    return (await this.request({ type: "get_session_stats" })) as PiSessionStats;
  }

  async getCommands(): Promise<PiRpcSlashCommand[]> {
    const data = (await this.request({ type: "get_commands" })) as {
      commands?: PiRpcSlashCommand[];
    };
    return data.commands ?? [];
  }

  cancelExtensionUiRequest(id: string): void {
    this.writeJsonLine({ type: "extension_ui_response", id, cancelled: true });
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    const result = await terminateWithTreeKill(this.child, {
      gracefulTimeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      forceTimeoutMs: FORCE_SHUTDOWN_TIMEOUT_MS,
      onForceSignal: () => {
        this.logger.warn(
          { timeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS },
          "Pi RPC process did not exit after SIGTERM; sending SIGKILL",
        );
      },
    });
    if (result === "kill-timeout") {
      this.logger.warn(
        { timeoutMs: FORCE_SHUTDOWN_TIMEOUT_MS },
        "Pi RPC process did not report exit after SIGKILL",
      );
    }
  }

  private request(command: PiRpcCommand, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error("Pi RPC session is closed"));
    }
    const id = `req_${this.nextRequestId}`;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`Pi RPC request timed out for ${command.type}\n${this.stderrBuffer}`.trim()),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writeJsonLine({ ...command, id });
    });
  }

  private writeJsonLine(value: unknown): void {
    if (this.disposed || this.child.stdin.destroyed || !this.child.stdin.writable) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.trim()) {
        this.handleLine(line);
      }
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.logger.warn({ error, line }, "Ignoring non-JSON Pi RPC stdout line");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }
    const message = parsed as Record<string, unknown>;
    if (message.type === "response") {
      this.handleResponse(message as unknown as PiRpcResponse);
      return;
    }
    this.emit(message as PiRuntimeEvent);
  }

  private handleResponse(response: PiRpcResponse): void {
    const id = response.id;
    if (!id) {
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (!response.success) {
      pending.reject(new Error(response.error ?? `Pi RPC ${response.command} failed`));
      return;
    }
    pending.resolve(response.data);
  }

  private emit(event: PiRuntimeEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  private failAll(error: Error): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
