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

export interface DshPermissionLaunch {
  /** Mode the session reports as current. */
  modeId: string | null | undefined;
  /** Environment that applies the selection, when the process has to start with it. */
  env: Record<string, string> | null;
}

/**
 * An explicit `DSH_PERMISSION_MODE` decides the process, so the session reports
 * the pinned preset whatever the caller selected; reporting the selection would
 * name a sandbox the process is not running. A value that is not a shipped preset
 * cannot be reported as a mode, so the selected preset launches instead.
 */
export function resolveDshPermissionLaunch(params: {
  modeId: string | null | undefined;
  configuredMode?: string;
}): DshPermissionLaunch {
  if (isDshPermissionMode(params.configuredMode)) {
    return { modeId: params.configuredMode, env: null };
  }
  if (!isDshPermissionMode(params.modeId)) {
    return { modeId: params.modeId, env: null };
  }
  return { modeId: params.modeId, env: { [DSH_PERMISSION_MODE_ENV]: params.modeId } };
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
    const launch = this.resolvePermissionLaunch(config.modeId, launchContext);
    return super.createSession(
      withMode(config, launch.modeId),
      withLaunchEnv(launchContext, launch.env),
    );
  }

  override async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const persistedModeId = handle.metadata?.["modeId"];
    const selectedModeId =
      overrides?.modeId ?? (typeof persistedModeId === "string" ? persistedModeId : undefined);
    const launch = this.resolvePermissionLaunch(selectedModeId, launchContext);
    return super.resumeSession(
      handle,
      launch.modeId === selectedModeId
        ? overrides
        : { ...overrides, modeId: launch.modeId ?? undefined },
      withLaunchEnv(launchContext, launch.env),
    );
  }

  /**
   * An explicit environment entry is the host pinning the mode, so it wins and the
   * session reports it. Otherwise a mode the user did not select leaves the variable
   * alone, and DSH's own default (profile patch or settings file) decides.
   */
  private resolvePermissionLaunch(
    modeId: string | null | undefined,
    launchContext: AgentLaunchContext | undefined,
  ): DshPermissionLaunch {
    const configuredMode =
      this.runtimeSettings?.env?.[DSH_PERMISSION_MODE_ENV] ??
      launchContext?.env?.[DSH_PERMISSION_MODE_ENV];
    const launch = resolveDshPermissionLaunch({ modeId, configuredMode });
    if (isDshPermissionMode(configuredMode) && configuredMode !== modeId) {
      this.logger.debug(
        { modeId, configuredMode },
        "explicit DSH_PERMISSION_MODE wins over the selected DeepSeek Harness mode",
      );
    }
    return launch;
  }
}

function withMode(
  config: AgentSessionConfig,
  modeId: string | null | undefined,
): AgentSessionConfig {
  return modeId === config.modeId ? config : { ...config, modeId: modeId ?? undefined };
}

function withLaunchEnv(
  launchContext: AgentLaunchContext | undefined,
  env: Record<string, string> | null,
): AgentLaunchContext | undefined {
  return env ? { ...launchContext, env: { ...launchContext?.env, ...env } } : launchContext;
}
