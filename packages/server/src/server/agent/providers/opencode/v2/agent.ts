import { OpenCodeV2Session } from "./session.js";
import { V2_CAPABILITIES } from "./capabilities.js";
import { controls, permissionRules, applyResumeOverrides } from "./configuration.js";
import { SessionMcp } from "./session-mcp.js";
import { commands } from "./commands.js";

import { waitForLocationReady } from "./readiness.js";

import type { SessionInfo } from "@opencode/client";

import type { Logger } from "pino";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentCreateSessionOptions,
  AgentResumeSessionOptions,
  AgentDraftControls,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
  FetchCatalogOptions,
  ImportableProviderSession,
  ImportProviderSessionInput,
  ImportProviderSessionContext,
  ListImportableSessionsOptions,
  ProviderRefreshContext,
} from "../../../agent-sdk-types.js";
import {
  createProviderEnv,
  type ProviderRuntimeSettings,
} from "../../../provider-launch-config.js";
import type { ManagedProcessRegistry } from "../../../../managed-processes/managed-processes.js";

import { importSessionFromPersistence } from "../../../provider-session-import.js";

import type { OpenCodeBridge } from "../bridge.js";
import { resolveOpenCodeHomeDir } from "../paths.js";
import { V2Runtime, type V2Connection, type V2DedicatedLaunch } from "./runtime.js";
import type { OpenCodeServiceSelection } from "./service-selection.js";
import { modelRef, modesFromV2, modelsFromV2 } from "./mapping.js";

/**
 * A wrapped launch gets a server of its own, started behind the wrap with the launch's environment,
 * so it never shares a server that runs outside its wrap.
 */
function dedicatedLaunch(launch: AgentLaunchContext | undefined): V2DedicatedLaunch | undefined {
  return launch?.wrap ? { wrap: launch.wrap, env: launch.env } : undefined;
}
interface ResumeTarget {
  handle: AgentPersistenceHandle;
  overrides: Partial<AgentSessionConfig> | undefined;
  launch: AgentLaunchContext | undefined;
  historyOnly: boolean;
}
interface PreparedLaunch {
  launch: AgentLaunchContext | undefined;
  /** The complete shell environment, when the launch sets one. */
  environment: Record<string, string> | undefined;
  mcp?: SessionMcp;
}

interface V2AgentOptions {
  logger: Logger;
  settings?: ProviderRuntimeSettings;
  managedProcesses?: ManagedProcessRegistry;
  bridge?: OpenCodeBridge;
  runtime?: Pick<V2Runtime, "acquire" | "shutdown">;
  selection?: OpenCodeServiceSelection;
}

export class OpenCodeV2AgentClient implements AgentClient {
  readonly provider = "opencode";
  readonly capabilities: AgentCapabilityFlags;
  private readonly runtime: Pick<V2Runtime, "acquire" | "shutdown">;
  private readonly connections = new Map<string, V2Connection>();
  constructor(private readonly options: V2AgentOptions) {
    const bridge = options.bridge;
    this.capabilities = { ...V2_CAPABILITIES, supportsNativePaseoTools: Boolean(bridge) };
    this.runtime =
      options.runtime ??
      new V2Runtime({
        ...options,
      });
  }
  async isAvailable() {
    return true;
  }
  async shutdown() {
    await this.runtime.shutdown();
  }
  async fetchCatalog(options: FetchCatalogOptions, context?: ProviderRefreshContext) {
    const connection = await this.runtime.acquire({
      fresh: options.force,
      signal: context?.signal,
    });
    const location = {
      directory: options.scope === "workspace" ? options.cwd : resolveOpenCodeHomeDir(),
    };
    const request = { signal: context?.signal };
    const activity = <T>(name: string, operation: () => Promise<T>) =>
      context ? context.runActivity(name, operation) : operation();
    try {
      await activity("plugin.list", () =>
        waitForLocationReady({ client: connection.client, location, signal: request.signal }),
      );
      if (options.force)
        await activity("paseo.bridge.refresh", () =>
          connection.refreshLocation(location.directory, request.signal),
        );
      const [models, agents, providers] = await Promise.all([
        activity("model.list", () => connection.client.model.list({ location }, request)),
        activity("agent.list", () => connection.client.agent.list({ location }, request)),
        activity("provider.list", () => connection.client.provider.list({ location }, request)),
      ]);
      if (!providers.data.length)
        throw new Error(
          "OpenCode has no connected providers. Authenticate using opencode auth login.",
        );
      return { models: modelsFromV2(models.data), modes: modesFromV2(agents.data) };
    } finally {
      await connection.release();
    }
  }
  async createSession(
    config: AgentSessionConfig,
    launch?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    const prepared = await this.prepareLaunch(config, launch, false);
    try {
      const connection = await this.runtime.acquire({ dedicated: dedicatedLaunch(launch) });
      try {
        const info = await connection.client.session.create({
          location: { directory: config.cwd },
          title: config.title,
          agent: config.modeId ?? "build",
          model: config.model ? modelRef(config.model, config.thinkingOptionId) : undefined,
          permissions: permissionRules(config),
        });
        return await this.attach(
          connection,
          info,
          config,
          prepared,
          options?.persistSession !== false,
        );
      } catch (error) {
        await connection.release();
        throw error;
      }
    } catch (error) {
      await prepared.mcp?.close();
      throw error;
    }
  }
  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launch?: AgentLaunchContext,
    options?: AgentResumeSessionOptions,
  ): Promise<AgentSession> {
    return this.resumeOn(
      async () => {
        // A live connection may run outside this launch's wrap, so a wrapped resume starts its own.
        const live = launch?.wrap
          ? undefined
          : this.connections.get(handle.nativeHandle ?? handle.sessionId)?.retain();
        return live ?? (await this.runtime.acquire({ dedicated: dedicatedLaunch(launch) }));
      },
      { handle, overrides, launch, historyOnly: options?.purpose === "history" },
    );
  }
  private async resumeOn(
    connect: () => Promise<V2Connection>,
    { handle, overrides, launch, historyOnly }: ResumeTarget,
  ): Promise<AgentSession> {
    const cwd = overrides?.cwd ?? handle.metadata?.cwd;
    if (typeof cwd !== "string")
      throw new Error("OpenCode resume requires the original working directory");
    const config: AgentSessionConfig = {
      ...handle.metadata,
      ...overrides,
      provider: "opencode",
      cwd,
    };
    const prepared = await this.prepareLaunch(config, launch, historyOnly);
    try {
      const connection = await connect();
      try {
        const info = await connection.client.session.get({
          sessionID: handle.nativeHandle ?? handle.sessionId,
        });
        await applyResumeOverrides(connection.client, info, overrides);
        return await this.attach(connection, info, config, prepared, true, historyOnly);
      } catch (error) {
        await connection.release();
        throw error;
      }
    } catch (error) {
      await prepared.mcp?.close();
      throw error;
    }
  }
  /**
   * Resolves what the session receives from its launch. OpenCode's own MCP servers are shared by
   * a location, so Paseo hosts each session's servers itself, before OpenCode sees the session.
   */
  private async prepareLaunch(
    config: AgentSessionConfig,
    launch: AgentLaunchContext | undefined,
    historyOnly: boolean,
  ): Promise<PreparedLaunch> {
    const environment = launch?.env
      ? createProviderEnv({ runtimeSettings: this.options.settings, overlays: [launch.env] })
      : undefined;
    const servers = config.mcpServers ?? {};
    if (historyOnly || Object.keys(servers).length === 0) return { launch, environment };
    if (!this.options.bridge)
      throw new Error("OpenCode MCP servers require the Paseo tool bridge, which is not running");
    const mcp = await SessionMcp.connect({
      servers,
      cwd: config.cwd,
      env: environment ?? createProviderEnv({ runtimeSettings: this.options.settings }),
      wrap: launch?.wrap,
    });
    return { launch, environment, mcp };
  }
  private async attach(
    connection: V2Connection,
    info: SessionInfo,
    config: AgentSessionConfig,
    { launch, environment, mcp }: PreparedLaunch,
    persist: boolean,
    historyOnly = false,
  ) {
    let ownedConnection = connection;
    const bridge = this.options.bridge;
    const bound = new Map<string, () => void>();
    const bindChild = (childId: string) => {
      this.connections.set(childId, ownedConnection);
      if (bound.has(childId)) return;
      const childUnbind = bridge?.bindSession({
        sessionId: childId,
        env: launch?.env ?? {},
        tools: launch?.paseoTools,
      });
      if (childUnbind) bound.set(childId, childUnbind);
    };
    // The bridge serves descendants before the session exists, so it reads the session late.
    let session: OpenCodeV2Session | undefined;
    let unbind: (() => void) | undefined;
    unbind = bridge?.bindSession({
      sessionId: info.id,
      env: launch?.env ?? {},
      tools: launch?.paseoTools,
      mcp,
      adoptDescendant: async (childId) => {
        bindChild(childId);
        await session?.adoptDescendant(childId);
      },
    });
    this.connections.set(info.id, connection);
    const releaseBindings = () => {
      unbind?.();
      for (const cleanup of bound.values()) cleanup();
      for (const [id, owner] of this.connections)
        if (owner === ownedConnection) this.connections.delete(id);
    };
    const moved = (next: V2Connection) => {
      for (const [id, owner] of this.connections)
        if (owner === ownedConnection) this.connections.set(id, next);
      ownedConnection = next;
    };
    session = new OpenCodeV2Session({
      connection,
      info,
      config,
      logger: this.options.logger,
      persist,
      requiresPaseoPlugin: Boolean(bridge),
      environment,
      mcp,
      unbind: releaseBindings,
      bindChild,
      acquire: () => this.runtime.acquire({ dedicated: dedicatedLaunch(launch) }),
      moved,
      historyOnly,
    });
    try {
      await session.initialize();
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }
  async listControls(config: AgentSessionConfig): Promise<AgentDraftControls> {
    return { controls, options: config.providerOptions ?? {} };
  }
  async listCommands(config: AgentSessionConfig) {
    const connection = await this.runtime.acquire();
    try {
      return await commands(connection.client, config.cwd);
    } finally {
      await connection.release();
    }
  }
  async listImportableSessions(
    options: ListImportableSessionsOptions = {},
  ): Promise<ImportableProviderSession[]> {
    const connection = await this.runtime.acquire();
    try {
      const sessions: SessionInfo[] = [];
      let cursor: string | undefined;
      const scanLimit = Math.min(options.scanLimit ?? 100, 500);
      do {
        const page = await connection.client.session.list({
          ...(cursor ? { cursor } : { directory: options.cwd, search: options.query }),
          limit: Math.min(50, scanLimit - sessions.length),
        });
        sessions.push(...page.data);
        cursor = page.cursor.next ?? undefined;
      } while (cursor && sessions.length < scanLimit);
      return sessions
        .filter((info) => !info.parentID && !info.time.archived)
        .slice(0, options.limit ?? 50)
        .map((info) => ({
          providerHandleId: info.id,
          cwd: info.location.directory,
          title: info.title ?? null,
          firstPromptPreview: null,
          lastPromptPreview: null,
          lastActivityAt: new Date(info.time.updated),
        }));
    } finally {
      await connection.release();
    }
  }
  async importSession(input: ImportProviderSessionInput, context: ImportProviderSessionContext) {
    // The lookup and the resume share one connection, so a wrapped import never starts a server
    // outside its wrap.
    const connection = await this.runtime.acquire({
      dedicated: dedicatedLaunch(context.launchContext),
    });
    try {
      const info = await connection.client.session.get({ sessionID: input.providerHandleId });
      return await importSessionFromPersistence({
        provider: "opencode",
        request: input,
        context,
        resumeSession: (handle, overrides, launch) =>
          this.resumeOn(async () => connection.retain(), {
            handle,
            overrides,
            launch,
            historyOnly: false,
          }),
        config: {
          title: info.title,
          modeId: info.agent,
          model: info.model ? `${info.model.providerID}/${info.model.id}` : undefined,
        },
      });
    } finally {
      await connection.release();
    }
  }
}
