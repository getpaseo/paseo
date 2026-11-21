import type { ToolPolicy } from "@getpaseo/protocol/agent-types";
import type { AgentLaunchContext, AgentSessionConfig, McpServerConfig } from "./agent-sdk-types.js";

/**
 * A tool-free agent runs with no tools at all: no built-in, MCP, Paseo, plugin or provider tools.
 * The daemon refuses one unless every layer can prove the empty tool surface before a tool could
 * run; nothing ever falls back to an ordinary agent.
 *
 * A live or stored agent config carries the mode; stored configs use `null` for absent fields.
 */
export interface ToolPolicyCarrier {
  toolPolicy?: Pick<ToolPolicy, "toolFree"> | null;
}

export function isToolFreeConfig(config: ToolPolicyCarrier | null | undefined): boolean {
  return config?.toolPolicy?.toolFree === true;
}

export type ToolFreeErrorReason =
  | "provider_unsupported"
  | "config_unsupported"
  | "tools_attached"
  | "mode_changed"
  | "surface_unverified";

/** Raised before any tool-free agent could run with a tool surface it cannot rule out. */
export class ToolFreeAgentError extends Error {
  readonly code = "tool_free_unsupported" as const;

  constructor(
    readonly reason: ToolFreeErrorReason,
    message: string,
    readonly provider?: string,
  ) {
    super(message);
    this.name = "ToolFreeAgentError";
  }
}

function hasServers(servers: Record<string, McpServerConfig> | undefined): boolean {
  return Object.keys(servers ?? {}).length > 0;
}

/** The request half: a tool-free policy is exactly `{ preapproved: [], toolFree: true }`. */
export function assertToolFreeRequest(config: AgentSessionConfig): void {
  if (!isToolFreeConfig(config)) return;
  if ((config.toolPolicy?.preapproved.length ?? 0) > 0) {
    throw new ToolFreeAgentError(
      "config_unsupported",
      "A tool-free agent cannot preapprove tools",
      config.provider,
    );
  }
  if (hasServers(config.mcpServers)) {
    throw new ToolFreeAgentError(
      "tools_attached",
      `A tool-free agent cannot have MCP servers (${Object.keys(config.mcpServers ?? {}).join(", ")})`,
      config.provider,
    );
  }
}

/**
 * The launch half, checked after every plugin hook has run and before the provider session
 * exists: nothing a hook, Paseo, or the saved config contributed may reach a tool-free session.
 */
export function assertToolFreeLaunch(input: {
  config: AgentSessionConfig;
  launchContext: AgentLaunchContext;
  pluginToolCount: number;
}): void {
  const { config, launchContext } = input;
  if (!isToolFreeConfig(config)) return;
  assertToolFreeRequest(config);
  const pluginServers = Object.keys(launchContext.mcpServers ?? {});
  if (pluginServers.length > 0) {
    const owners = pluginServers.map(
      (name) => `${name} (${launchContext.mcpServerOwners?.[name] ?? "unknown plugin"})`,
    );
    throw new ToolFreeAgentError(
      "tools_attached",
      `A plugin attached MCP servers to a tool-free agent: ${owners.join(", ")}`,
      config.provider,
    );
  }
  if (input.pluginToolCount > 0 || launchContext.paseoTools) {
    throw new ToolFreeAgentError(
      "tools_attached",
      "Tools were attached to a tool-free agent",
      config.provider,
    );
  }
}

/** Tool-free is fixed when the agent is created; no later config may add or remove it. */
export function assertToolFreeRetained(input: {
  previous: ToolPolicyCarrier | null | undefined;
  next: AgentSessionConfig;
}): void {
  if (!input.previous) return;
  if (isToolFreeConfig(input.previous) !== isToolFreeConfig(input.next)) {
    throw new ToolFreeAgentError(
      "mode_changed",
      isToolFreeConfig(input.previous)
        ? "A tool-free agent cannot be reopened with tools"
        : "An agent created with tools cannot become tool-free",
      input.next.provider,
    );
  }
}

export interface ToolFreeCreateContent {
  config: Pick<AgentSessionConfig, "provider" | "toolPolicy">;
  initialPrompt?: string;
  images?: readonly unknown[];
  attachments?: readonly unknown[];
  outputSchema?: unknown;
}

/**
 * A create request hands its prompt and attachments to helpers that run before the agent does,
 * such as workspace and branch naming, and to a caller that has not yet seen the agent reported
 * tool-free. A tool-free create carries none of them; the prompt follows once the agent exists.
 */
export function assertToolFreeCreateCarriesNoContent(input: ToolFreeCreateContent): void {
  if (!isToolFreeConfig(input.config)) return;
  if (
    (input.initialPrompt?.length ?? 0) > 0 ||
    (input.images?.length ?? 0) > 0 ||
    (input.attachments?.length ?? 0) > 0 ||
    input.outputSchema !== undefined
  ) {
    throw new ToolFreeAgentError(
      "config_unsupported",
      "A tool-free agent takes its prompt after creation, not in the create request",
      input.config.provider,
    );
  }
}

/** Requests that create a workspace, or run a Hub execution, always carry content. */
export function assertNotToolFree(input: {
  config: Pick<AgentSessionConfig, "provider" | "toolPolicy"> | null | undefined;
  surface: string;
}): void {
  if (!isToolFreeConfig(input.config)) return;
  throw new ToolFreeAgentError(
    "config_unsupported",
    `${input.surface} cannot create a tool-free agent`,
    input.config?.provider,
  );
}
