import type { Logger } from "pino";

import type { AgentMode, AgentSessionConfig } from "../agent-sdk-types.js";
import {
  type ACPProviderModeWriteResult,
  type ACPProviderModeWriterContext,
  type SessionStateResponse,
} from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

/** Ask before tool executions — Grok's interactive default (`permission_mode = "ask"`). */
export const GROK_ASK_MODE_ID = "ask";

/**
 * Grok's native unattended permission mode.
 * Matches CLI `--always-approve` / `--yolo` and config `permission_mode = "always-approve"`.
 * Grok does not advertise this as an ACP session mode; Paseo maps it onto the native
 * launch flag and the `/always-approve on|off` available command.
 */
export const GROK_ALWAYS_APPROVE_MODE_ID = "always-approve";

const GROK_ALWAYS_APPROVE_LAUNCH_FLAGS = new Set(["--always-approve", "--yolo"]);

export const GROK_MODES: AgentMode[] = [
  {
    id: GROK_ASK_MODE_ID,
    label: "Ask",
    description: "Prompt before shell and tool executions",
  },
  {
    id: GROK_ALWAYS_APPROVE_MODE_ID,
    label: "Always Approve",
    description:
      "Auto-approve all tool executions for this session via Grok's native always-approve mode. Allows potentially destructive shell commands and file operations.",
    isUnattended: true,
  },
];

interface GrokACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

/**
 * Grok is installed from the ACP catalog as `grok agent stdio`. Grok's permission
 * modes are not ACP session modes — they are process/session settings controlled by:
 *   - `grok agent --always-approve stdio` (session launch)
 *   - `/always-approve on|off` (in-session available command)
 *   - `~/.grok/config.toml` `[ui] permission_mode` (user global; not used here)
 *
 * Paseo surfaces Ask / Always Approve in the mode picker, drives Grok through those
 * native paths, and keeps a client-side auto-approve fallback if Grok still emits
 * `session/request_permission` while Always Approve is selected.
 */
export class GrokACPAgentClient extends GenericACPAgentClient {
  constructor(options: GrokACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId ?? "grok",
      label: options.label ?? "Grok",
      providerParams: options.providerParams,
      defaultModes: GROK_MODES,
      sessionResponseTransformer: transformGrokSessionResponse,
      resolveSessionCommand: resolveGrokSessionCommand,
      providerModeWriter: writeGrokProviderMode,
      // Fallback only: when Grok is correctly in always-approve it does not call
      // session/request_permission. This covers races / older Grok builds.
      autoApproveModeIds: [GROK_ALWAYS_APPROVE_MODE_ID],
    });
  }
}

/**
 * Inject or strip Grok's native `--always-approve` launch flag.
 * Catalog command is `["grok", "agent", "stdio"]` → `["grok", "agent", "--always-approve", "stdio"]`.
 */
export function withGrokAlwaysApproveLaunchFlag(
  command: [string, ...string[]],
  enabled: boolean,
): [string, ...string[]] {
  const [binary, ...args] = command;
  const withoutFlags = args.filter((arg) => !GROK_ALWAYS_APPROVE_LAUNCH_FLAGS.has(arg));
  if (!enabled) {
    return withoutFlags.length > 0
      ? ([binary, ...withoutFlags] as [string, ...string[]])
      : [binary];
  }

  const agentIndex = withoutFlags.indexOf("agent");
  if (agentIndex >= 0) {
    const next = [...withoutFlags];
    next.splice(agentIndex + 1, 0, "--always-approve");
    return [binary, ...next] as [string, ...string[]];
  }

  const stdioIndex = withoutFlags.lastIndexOf("stdio");
  if (stdioIndex >= 0) {
    const next = [...withoutFlags];
    next.splice(stdioIndex, 0, "--always-approve");
    return [binary, ...next] as [string, ...string[]];
  }

  return [binary, "--always-approve", ...withoutFlags] as [string, ...string[]];
}

export function resolveGrokSessionCommand(
  command: [string, ...string[]],
  config: AgentSessionConfig,
): [string, ...string[]] {
  return withGrokAlwaysApproveLaunchFlag(command, config.modeId === GROK_ALWAYS_APPROVE_MODE_ID);
}

function isGrokPermissionModeId(modeId: string | null | undefined): modeId is string {
  return modeId === GROK_ASK_MODE_ID || modeId === GROK_ALWAYS_APPROVE_MODE_ID;
}

export function transformGrokSessionResponse(
  response: SessionStateResponse,
  sessionConfig?: AgentSessionConfig,
): SessionStateResponse {
  const upstreamModes = response.modes?.availableModes ?? [];
  const upstreamIds = new Set(upstreamModes.map((mode) => mode.id));
  const syntheticModes = GROK_MODES.filter((mode) => !upstreamIds.has(mode.id)).map((mode) => ({
    id: mode.id,
    name: mode.label,
    description: mode.description ?? null,
  }));
  const preferredModeId = isGrokPermissionModeId(sessionConfig?.modeId)
    ? sessionConfig.modeId
    : GROK_ASK_MODE_ID;

  if (upstreamModes.length === 0) {
    return {
      ...response,
      modes: {
        availableModes: GROK_MODES.map((mode) => ({
          id: mode.id,
          name: mode.label,
          description: mode.description ?? null,
        })),
        // Prefer the session's configured Paseo mode so Always Approve at create
        // time is not rewritten to Ask before applyConfiguredOverrides.
        currentModeId: response.modes?.currentModeId ?? preferredModeId,
      },
    };
  }

  return {
    ...response,
    modes: {
      ...response.modes,
      availableModes: [...upstreamModes, ...syntheticModes],
      // SessionModeState.currentModeId is a required string in the ACP schema.
      currentModeId: response.modes?.currentModeId ?? upstreamModes[0]?.id ?? preferredModeId,
    },
  };
}

/**
 * Drive Grok's native in-session permission toggle via the documented
 * `/always-approve on|off` available command (not ACP setSessionMode).
 */
export async function writeGrokProviderMode(
  context: ACPProviderModeWriterContext,
): Promise<ACPProviderModeWriteResult> {
  if (context.requestedModeId === GROK_ALWAYS_APPROVE_MODE_ID) {
    if (context.currentModeId !== GROK_ALWAYS_APPROVE_MODE_ID) {
      await context.connection.prompt({
        sessionId: context.sessionId,
        prompt: [{ type: "text", text: "/always-approve on" }],
      });
    }
    return {
      handled: true,
      currentModeId: GROK_ALWAYS_APPROVE_MODE_ID,
    };
  }

  if (context.requestedModeId === GROK_ASK_MODE_ID) {
    if (context.currentModeId === GROK_ALWAYS_APPROVE_MODE_ID) {
      await context.connection.prompt({
        sessionId: context.sessionId,
        prompt: [{ type: "text", text: "/always-approve off" }],
      });
    }
    return {
      handled: true,
      currentModeId: GROK_ASK_MODE_ID,
    };
  }

  return { handled: false };
}
