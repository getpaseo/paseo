import { OpenCodeV2Session } from "./session.js";
import { V2_CAPABILITIES } from "./capabilities.js";
import {
  features,
  permissionRules,
  applyResumeOverrides,
  requiresDedicatedV2Server,
} from "./configuration.js";
import { commands } from "./commands.js";

import { waitForLocationReady, awaitPaseoPlugin } from "./readiness.js";

import type { SessionInfo } from "@opencode/client";

import type { Logger } from "pino";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentCreateSessionOptions,
  AgentFeature,
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
import type { ProviderRuntimeSettings } from "../../../provider-launch-config.js";
import type { ManagedProcessRegistry } from "../../../../managed-processes/managed-processes.js";

import { importSessionFromPersistence } from "../../../provider-session-import.js";

import type { OpenCodeBridge } from "../bridge.js";
import { resolveOpenCodeHomeDir } from "../paths.js";
import { V2Runtime, type V2Connection } from "./runtime.js";
import { modelRef, modesFromV2, modelsFromV2 } from "./mapping.js";

interface V2AgentOptions {
  logger: Logger;
  settings?: ProviderRuntimeSettings;
  managedProcesses?: ManagedProcessRegistry;
  bridge?: OpenCodeBridge;
  runtime?: Pick<V2Runtime, "acquire" | "shutdown">;
}

export class OpenCodeV2AgentClient implements AgentClient {
  readonly provider = "opencode";
  readonly capabilities: AgentCapabilityFlags;
  private readonly runtime: Pick<V2Runtime, "acquire" | "shutdown">;
  private readonly connections = new Map<string, V2Connection>();
  constructor(private readonly options: V2AgentOptions) {
    this.capabilities = { ...V2_CAPABILITIES, supportsNativePaseoTools: Boolean(options.bridge) };
    this.runtime =
      options.runtime ??
      new V2Runtime({
        ...options,
        decorateEnv: options.bridge ? (env) => options.bridge!.decorateV2ServerEnv(env) : undefined,
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
    const connection = await this.runtime.acquire(
      requiresDedicatedV2Server(config, launch) ? { env: launch?.env, dedicated: true } : {},
    );
    try {
      const info = await connection.client.session.create({
        location: { directory: config.cwd },
        title: config.title,
        agent: config.modeId ?? "build",
        model: config.model ? modelRef(config.model, config.thinkingOptionId) : undefined,
        permissions: permissionRules(config),
      });
      return await this.attach(connection, info, config, launch, options?.persistSession !== false);
    } catch (error) {
      await connection.release();
      throw error;
    }
  }
  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launch?: AgentLaunchContext,
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
    const connection =
      this.connections.get(handle.nativeHandle ?? handle.sessionId)?.retain() ??
      (await this.runtime.acquire(
        requiresDedicatedV2Server(config, launch) ? { env: launch?.env, dedicated: true } : {},
      ));
    try {
      const info = await connection.client.session.get({
        sessionID: handle.nativeHandle ?? handle.sessionId,
      });
      await applyResumeOverrides(connection.client, info, overrides);
      return await this.attach(connection, info, config, launch, true);
    } catch (error) {
      await connection.release();
      throw error;
    }
  }
  private async attach(
    connection: V2Connection,
    info: SessionInfo,
    config: AgentSessionConfig,
    launch: AgentLaunchContext | undefined,
    persist: boolean,
  ) {
    const unbind = this.options.bridge?.bindSession({
      sessionId: info.id,
      env: launch?.env ?? {},
      tools: launch?.paseoTools,
    });
    const bound = new Map<string, () => void>();
    const bindChild = (childId: string) => {
      this.connections.set(childId, connection);
      if (bound.has(childId)) return;
      const childUnbind = this.options.bridge?.bindSession({
        sessionId: childId,
        env: launch?.env ?? {},
        tools: launch?.paseoTools,
      });
      if (childUnbind) bound.set(childId, childUnbind);
    };
    this.connections.set(info.id, connection);
    const releaseBindings = () => {
      unbind?.();
      for (const cleanup of bound.values()) cleanup();
      for (const [id, owner] of this.connections)
        if (owner === connection) this.connections.delete(id);
    };
    const session = new OpenCodeV2Session(
      connection,
      info,
      config,
      this.options.logger,
      persist,
      Boolean(this.options.bridge),
      releaseBindings,
      bindChild,
    );
    try {
      if (this.options.bridge) {
        const location = { directory: config.cwd };
        await awaitPaseoPlugin({ client: connection.client, location });
      }
      await session.initialize(launch);
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }
  async listFeatures(config: AgentSessionConfig): Promise<AgentFeature[]> {
    return features(config);
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
    const connection = await this.runtime.acquire();
    try {
      const info = await connection.client.session.get({ sessionID: input.providerHandleId });
      return await importSessionFromPersistence({
        provider: "opencode",
        request: input,
        context,
        resumeSession: this.resumeSession.bind(this),
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
