import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { Readable, Writable } from "node:stream";
import type {
  Client as ACPClient,
  ClientCapabilities as ACPClientCapabilities,
  CreateTerminalRequest,
  InitializeResponse,
  KillTerminalRequest,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { ClientSideConnection, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { Logger } from "pino";

import { spawnProcess } from "../../../utils/spawn.js";
import { terminateWithTreeKill, type ProcessTerminator } from "../../../utils/tree-kill.js";
import {
  checkProviderLaunchAvailable,
  createProviderEnvSpec,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../provider-launch-config.js";
import {
  assertChildWithPipes,
  buildACPClientCapabilities,
  createLoggedNdJsonStream,
  toACPRequestError,
  type ACPAgentSession,
  type ACPClientCapabilityMeta,
  type ACPTransportAcquisition,
} from "./acp-agent.js";

export interface ACPMultiplexConnectionManagerOptions {
  logger: Logger;
  provider: string;
  defaultCommand: [string, ...string[]];
  runtimeSettings?: ProviderRuntimeSettings;
  launchEnv?: Record<string, string>;
  clientCapabilityMeta?: ACPClientCapabilityMeta;
  clientCapabilities?: ACPClientCapabilities;
  terminateProcess?: ProcessTerminator;
  idleTimeoutMs?: number;
}

const SESSION_EPHEMERAL_ENV_PREFIXES = ["PASEO_AGENT_", "PASEO_SESSION_"];
const SESSION_EPHEMERAL_ENV_KEYS = new Set([
  "PASEO_AGENT_ID",
  "PASEO_AGENT_CWD",
  "PASEO_SESSION_ID",
]);

export function filterTransportEnv(
  env?: Record<string, string>,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (
      SESSION_EPHEMERAL_ENV_KEYS.has(key) ||
      SESSION_EPHEMERAL_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      continue;
    }
    filtered[key] = value;
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

export class ACPMultiplexConnectionManager {
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientSideConnection | null = null;
  private initializeResponse: InitializeResponse | null = null;
  private readonly activeSessions = new Map<string, ACPAgentSession>();
  private readonly terminalSessions = new Map<string, ACPAgentSession>();
  clientDispatcher: ACPClient | null = null;
  private activeAcquisitions = 0;
  private startPromise: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  private readonly logger: Logger;
  private readonly provider: string;
  private readonly defaultCommand: [string, ...string[]];
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly launchEnv?: Record<string, string>;
  private readonly clientCapabilityMeta?: ACPClientCapabilityMeta;
  private readonly clientCapabilities?: ACPClientCapabilities;
  private readonly terminateProcess: ProcessTerminator;
  private readonly idleTimeoutMs: number;

  constructor(options: ACPMultiplexConnectionManagerOptions) {
    this.logger = options.logger.child({
      module: "agent",
      provider: options.provider,
      component: "acp-multiplex-manager",
    });
    this.provider = options.provider;
    this.defaultCommand = options.defaultCommand;
    this.runtimeSettings = options.runtimeSettings;
    this.launchEnv = options.launchEnv;
    this.clientCapabilityMeta = options.clientCapabilityMeta;
    this.clientCapabilities = options.clientCapabilities;
    this.terminateProcess = options.terminateProcess ?? terminateWithTreeKill;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
  }

  async acquire(options?: {
    cwd?: string;
    launchEnv?: Record<string, string>;
  }): Promise<ACPTransportAcquisition> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    await this.ensureStarted(options?.cwd, options?.launchEnv);
    this.activeAcquisitions++;

    return {
      child: this.child,
      connection: this.connection!,
      initialize: this.initializeResponse!,
      registerSession: (session: ACPAgentSession) => {
        const id = session.id;
        if (id) {
          this.activeSessions.set(id, session);
        }
      },
      unregisterSession: (sessionId: string) => {
        this.activeSessions.delete(sessionId);
        for (const [termId, termSession] of this.terminalSessions.entries()) {
          if (termSession.id === sessionId) {
            this.terminalSessions.delete(termId);
          }
        }
      },
      release: async () => {
        this.activeAcquisitions = Math.max(0, this.activeAcquisitions - 1);
        if (this.activeAcquisitions === 0 && this.activeSessions.size === 0) {
          this.scheduleIdleShutdown();
        }
      },
    };
  }

  private ensureStarted(cwd?: string, requestEnv?: Record<string, string>): Promise<void> {
    if (this.connection && this.initializeResponse) {
      return Promise.resolve();
    }
    if (!this.startPromise) {
      this.startPromise = this.startProcess(cwd, requestEnv).finally(() => {
        this.startPromise = null;
      });
    }
    return this.startPromise;
  }

  private async startProcess(
    spawnCwd?: string,
    requestEnv?: Record<string, string>,
  ): Promise<void> {
    const prefix = await resolveProviderLaunch({
      commandConfig: this.runtimeSettings?.command,
      defaultBinary: this.defaultCommand[0],
    });
    const availability = await checkProviderLaunchAvailable(prefix);
    if (!availability.available) {
      throw new Error(`${this.provider} command '${this.defaultCommand[0]}' not found`);
    }

    const command = prefix.command;
    const args = [...prefix.args, ...this.defaultCommand.slice(1)];
    const filteredRequestEnv = filterTransportEnv(requestEnv);
    const envOverlays = [this.launchEnv, filteredRequestEnv].filter(Boolean) as Array<
      Record<string, string>
    >;
    const child = spawnProcess(command, args, {
      cwd: spawnCwd ?? homedir(),
      ...createProviderEnvSpec({
        runtimeSettings: this.runtimeSettings,
        overlays: envOverlays,
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    assertChildWithPipes(child);

    const stderrChunks: string[] = [];
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(chunk.toString());
    });

    child.once("exit", (code, signal) => {
      this.logger.info(
        { code, signal, activeSessions: this.activeSessions.size },
        "Multiplexed ACP process exited",
      );
      const diagnostic = stderrChunks.join("").trim() || undefined;
      const sessions = Array.from(this.activeSessions.values());
      for (const session of sessions) {
        session.handleProcessExit(code, signal, diagnostic);
      }
      this.child = null;
      this.connection = null;
      this.initializeResponse = null;
      this.activeSessions.clear();
      this.terminalSessions.clear();
      this.activeAcquisitions = 0;
    });

    const stream = createLoggedNdJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout),
      { logger: this.logger, provider: this.provider },
    );

    const router: ACPClient = {
      requestPermission: async (
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        const session = this.activeSessions.get(params.sessionId);
        if (!session) {
          return { outcome: { outcome: "cancelled" } };
        }
        return session.requestPermission(params);
      },
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        const session = this.activeSessions.get(params.sessionId);
        if (session) {
          await session.sessionUpdate(params);
        } else {
          this.logger.debug(
            { sessionId: params.sessionId },
            "sessionUpdate dropped for unregistered session",
          );
        }
      },
      readTextFile: async (params: ReadTextFileRequest): Promise<ReadTextFileResponse> => {
        const session = this.activeSessions.get(params.sessionId);
        if (!session) {
          throw new Error(
            `[acp-multiplex] No active session found for session ID: ${params.sessionId}`,
          );
        }
        return session.readTextFile(params);
      },
      writeTextFile: async (params: WriteTextFileRequest): Promise<WriteTextFileResponse> => {
        const session = this.activeSessions.get(params.sessionId);
        if (!session) {
          throw new Error(
            `[acp-multiplex] No active session found for session ID: ${params.sessionId}`,
          );
        }
        return session.writeTextFile(params);
      },
      createTerminal: async (params: CreateTerminalRequest): Promise<{ terminalId: string }> => {
        const session = this.activeSessions.get(params.sessionId);
        if (!session) {
          throw new Error(
            `[acp-multiplex] No active session found for session ID: ${params.sessionId}`,
          );
        }
        const result = await session.createTerminal(params);
        if (result?.terminalId) {
          this.terminalSessions.set(result.terminalId, session);
        }
        return result;
      },
      terminalOutput: async (params: TerminalOutputRequest): Promise<TerminalOutputResponse> => {
        const session = this.terminalSessions.get(params.terminalId);
        if (!session) {
          throw new Error(
            `[acp-multiplex] No active session found for terminal ID: ${params.terminalId}`,
          );
        }
        return session.terminalOutput(params);
      },
      waitForTerminalExit: async (params: WaitForTerminalExitRequest) => {
        const session = this.terminalSessions.get(params.terminalId);
        if (!session) {
          throw new Error(
            `[acp-multiplex] No active session found for terminal ID: ${params.terminalId}`,
          );
        }
        return session.waitForTerminalExit(params);
      },
      killTerminal: async (params: KillTerminalRequest): Promise<Record<string, never>> => {
        const session = this.terminalSessions.get(params.terminalId);
        if (!session) {
          throw new Error(
            `[acp-multiplex] No active session found for terminal ID: ${params.terminalId}`,
          );
        }
        return session.killTerminal(params);
      },
      releaseTerminal: async (params: ReleaseTerminalRequest): Promise<void> => {
        const session = this.terminalSessions.get(params.terminalId);
        this.terminalSessions.delete(params.terminalId);
        if (session) {
          await session.releaseTerminal(params);
        }
      },
    };

    this.clientDispatcher = router;
    const connection = new ClientSideConnection(() => router, stream);
    this.child = child;
    this.connection = connection;

    try {
      const initialize = await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: buildACPClientCapabilities(
          this.clientCapabilityMeta,
          this.clientCapabilities,
        ),
        clientInfo: { name: "Paseo", version: "dev" },
      });
      this.initializeResponse = initialize;
    } catch (error) {
      if (this.child) {
        await this.terminateProcess(this.child, {
          gracefulTimeoutMs: 2_000,
          forceTimeoutMs: 2_000,
        });
        this.child = null;
      }
      this.connection = null;
      throw toACPRequestError(error);
    }
  }

  private scheduleIdleShutdown(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    if (this.idleTimeoutMs <= 0) {
      void this.shutdown();
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.activeAcquisitions === 0 && this.activeSessions.size === 0) {
        void this.shutdown();
      }
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  async shutdown(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const child = this.child;
    this.child = null;
    this.connection = null;
    this.initializeResponse = null;
    this.clientDispatcher = null;
    this.activeSessions.clear();
    this.terminalSessions.clear();
    this.activeAcquisitions = 0;

    if (child) {
      await this.terminateProcess(child, { gracefulTimeoutMs: 2_000, forceTimeoutMs: 2_000 });
    }
  }
}
