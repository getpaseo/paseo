import type { Logger } from "pino";
import type {
  AgentClient,
  AgentSessionConfig,
  AgentLaunchContext,
  AgentCreateSessionOptions,
  AgentPersistenceHandle,
  FetchCatalogOptions,
  ProviderRefreshContext,
  ListImportableSessionsOptions,
  ImportProviderSessionInput,
  ImportProviderSessionContext,
} from "../../agent-sdk-types.js";
import {
  createProviderEnvSpec,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import { execCommand } from "../../../../utils/spawn.js";
import { OpenCodeAgentClient } from "../opencode-agent.js";
import { OpenCodeV2AgentClient } from "./v2/agent.js";

export function openCodeMajorVersion(output: string): 1 | 2 {
  const version = output.trim().match(/^(?:opencode\s+)?v?(\d+)\.\d+\.\d+(?:[-+][\w.-]+)?$/i);
  if (!version)
    throw new Error("Could not identify OpenCode version; check the configured command");
  if (version[1] === "1") return 1;
  if (version[1] === "2") return 2;
  throw new Error(
    `Unsupported OpenCode major version ${version[1]}; supported versions are 1 and 2`,
  );
}

// Selection belongs to the configured client, which provider reload replaces.
export class OpenCodeRuntimeClient implements AgentClient {
  readonly provider = "opencode";
  readonly capabilities;
  readonly resolveCreateConfig;
  readonly isCreateConfigUnattended;
  private selected: Promise<OpenCodeAgentClient | OpenCodeV2AgentClient> | null = null;
  private readonly legacy: OpenCodeAgentClient;
  constructor(
    private readonly logger: Logger,
    private readonly settings?: ProviderRuntimeSettings,
    private readonly options: NonNullable<
      ConstructorParameters<typeof OpenCodeAgentClient>[2]
    > = {},
  ) {
    this.legacy = new OpenCodeAgentClient(logger, settings, options);
    this.capabilities = this.legacy.capabilities;
    this.resolveCreateConfig = this.legacy.resolveCreateConfig;
    this.isCreateConfigUnattended = this.legacy.isCreateConfigUnattended;
  }
  private client(): Promise<OpenCodeAgentClient | OpenCodeV2AgentClient> {
    this.selected ??= (async () => {
      const launch = await resolveProviderLaunch({
        commandConfig: this.settings?.command,
        defaultBinary: "opencode",
      });
      const result = await execCommand(launch.command, [...launch.args, "--version"], {
        ...createProviderEnvSpec({ runtimeSettings: this.settings }),
        timeout: 5_000,
      });
      if (openCodeMajorVersion(result.stdout) === 1) return this.legacy;
      return new OpenCodeV2AgentClient({
        logger: this.logger,
        settings: this.settings,
        managedProcesses: this.options.managedProcesses,
        bridge: this.options.bridge,
      });
    })();
    return this.selected;
  }
  async isAvailable() {
    return this.legacy.isAvailable();
  }
  async getDiagnostic() {
    return this.legacy.getDiagnostic();
  }
  async createSession(
    config: AgentSessionConfig,
    launch?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ) {
    return (await this.client()).createSession(config, launch, options);
  }
  async resumeSession(
    handle: AgentPersistenceHandle,
    config?: Partial<AgentSessionConfig>,
    launch?: AgentLaunchContext,
  ) {
    return (await this.client()).resumeSession(handle, config, launch);
  }
  async fetchCatalog(options: FetchCatalogOptions, context?: ProviderRefreshContext) {
    return (await this.client()).fetchCatalog(options, context);
  }
  async listCommands(config: AgentSessionConfig) {
    return (await this.client()).listCommands(config);
  }
  async listFeatures(config: AgentSessionConfig) {
    return (await this.client()).listFeatures(config);
  }
  async listImportableSessions(options?: ListImportableSessionsOptions) {
    return (await this.client()).listImportableSessions(options);
  }
  async importSession(input: ImportProviderSessionInput, context: ImportProviderSessionContext) {
    return (await this.client()).importSession(input, context);
  }
  async archiveNativeSession(handle: AgentPersistenceHandle) {
    const client = await this.client();
    if (client instanceof OpenCodeAgentClient) await client.archiveNativeSession(handle);
  }
  async unarchiveNativeSession(handle: AgentPersistenceHandle) {
    const client = await this.client();
    if (client instanceof OpenCodeAgentClient) await client.unarchiveNativeSession(handle);
  }
  async shutdown() {
    if (this.selected) await (await this.selected.catch(() => null))?.shutdown?.();
  }
}
