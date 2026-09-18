import type { Logger } from "pino";

import type {
  AgentLaunchContext,
  AgentMode,
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
} from "../agent-sdk-types.js";
import type { ACPProviderModeWriteResult, ACPProviderModeWriterContext } from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

/**
 * DSH resolves its sandbox mode and approval policy when the ACP process starts:
 * the shipped `acp` profile reads this variable for `sandbox-policy.mode` and
 * derives `approval.policy` from it (`danger-full-access` never asks). The ACP
 * surface exposes no permission config option, so a preset is selected by
 * launching the process with this value rather than by writing to a live session.
 */
export const DSH_PERMISSION_MODE_ENV = "DSH_PERMISSION_MODE";

/** DSH's shipped permission presets, in the order its own selector lists them. */
export const DSH_PERMISSION_MODES: AgentMode[] = [
  {
    id: "read-only",
    label: "Read Only",
    description: "Sandboxed to reads; commands that write or execute ask first.",
  },
  {
    id: "workspace-write",
    label: "Workspace Write",
    description: "Reads and writes inside the workspace; other commands ask first.",
  },
  {
    id: "danger-full-access",
    label: "Full Access",
    description: "No sandbox and no approval prompts.",
  },
];

export function isDshPermissionMode(modeId: string | null | undefined): modeId is string {
  return DSH_PERMISSION_MODES.some((mode) => mode.id === modeId);
}

/**
 * Launch environment for a selected preset. A mode the user did not select
 * leaves the variable alone, so a host that configures DSH's own default
 * (profile patch, settings file, or an environment entry on the provider) keeps
 * deciding it, and `configuredMode` reports the explicit entry that wins.
 */
export function resolveDshPermissionEnv(params: {
  modeId: string | null | undefined;
  configuredMode?: string;
}): Record<string, string> | null {
  if (!isDshPermissionMode(params.modeId) || params.configuredMode !== undefined) {
    return null;
  }
  return { [DSH_PERMISSION_MODE_ENV]: params.modeId };
}

/**
 * A mode is fixed for the life of the process, so a switch inside a running
 * session is answered with the one action that actually changes it. Returning no
 * `currentModeId` keeps the session on the mode it launched with.
 */
export async function writeDshProviderMode(
  context: ACPProviderModeWriterContext,
): Promise<ACPProviderModeWriteResult> {
  if (!isDshPermissionMode(context.requestedModeId)) {
    return { handled: false };
  }
  return {
    handled: true,
    notice: {
      type: "warning",
      message: "Start a new DeepSeek Harness session to change the permission mode.",
    },
  };
}

interface DshACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

export class DshACPAgentClient extends GenericACPAgentClient {
  constructor(options: DshACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      defaultModes: DSH_PERMISSION_MODES,
      providerModeWriter: writeDshProviderMode,
    });
  }

  override async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    return super.createSession(config, this.withPermissionMode(config.modeId, launchContext));
  }

  override async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const persistedModeId = handle.metadata?.["modeId"];
    const modeId =
      overrides?.modeId ?? (typeof persistedModeId === "string" ? persistedModeId : undefined);
    return super.resumeSession(handle, overrides, this.withPermissionMode(modeId, launchContext));
  }

  /**
   * A mode the user did not select leaves the variable alone, so a host that
   * configures DSH's own default (profile patch, settings file, or an explicit
   * environment entry on the provider) keeps deciding it.
   */
  private withPermissionMode(
    modeId: string | null | undefined,
    launchContext: AgentLaunchContext | undefined,
  ): AgentLaunchContext | undefined {
    const configuredMode =
      this.runtimeSettings?.env?.[DSH_PERMISSION_MODE_ENV] ??
      launchContext?.env?.[DSH_PERMISSION_MODE_ENV];
    const env = resolveDshPermissionEnv({ modeId, configuredMode });
    if (!env) {
      if (isDshPermissionMode(modeId) && configuredMode !== undefined) {
        this.logger.debug(
          { modeId, configuredMode },
          "explicit DSH_PERMISSION_MODE wins over the selected DeepSeek Harness mode",
        );
      }
      return launchContext;
    }

    return {
      ...launchContext,
      env: { ...launchContext?.env, ...env },
    };
  }
}
