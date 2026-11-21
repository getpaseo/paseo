import type { ProviderOptions } from "@getpaseo/protocol/agent-types";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { ToolFreeAgentError } from "../../tool-free.js";
import type { ClaudeOptions } from "./query.js";

/**
 * Provider options a tool-free Claude agent may carry. Every other option can widen what the
 * Claude Code process loads (CLI flags, settings, permission rules, sandbox exceptions), so a
 * tool-free agent refuses it, whether the agent set it or the provider's config.json defaults did.
 */
const TOOL_FREE_SAFE_OPTION_KEYS = new Set(["fast_mode", "ultracode", "disallowedTools"]);

/**
 * Context-usage rows a tool-free session may report before a prompt. A tool row, an MCP row, a
 * skill or agent listing, or any row this list does not know fails the check.
 */
const TOOL_FREE_CONTEXT_CATEGORY_IDS = new Set([
  "system_prompt",
  "memory_files",
  "messages",
  "autocompact_buffer",
  "compact_buffer",
  "free_space",
]);

export interface ClaudeToolFreeLaunchInput {
  provider: string;
  runtimeSettings: ProviderRuntimeSettings | undefined;
  providerOptions: ProviderOptions | undefined;
}

/** Static half, checked before an agent is created and again when its session launches. */
export function assertClaudeToolFreeLaunchable(input: ClaudeToolFreeLaunchInput): void {
  const commandMode = input.runtimeSettings?.command?.mode ?? "default";
  if (commandMode !== "default") {
    throw new ToolFreeAgentError(
      "config_unsupported",
      `Provider '${input.provider}' uses a custom Claude command (${commandMode}); tool-free agents need the default Claude Code launch`,
      input.provider,
    );
  }
  const unsafe = Object.keys(input.providerOptions ?? {}).filter(
    (key) => !TOOL_FREE_SAFE_OPTION_KEYS.has(key) && input.providerOptions?.[key] !== undefined,
  );
  if (unsafe.length > 0) {
    throw new ToolFreeAgentError(
      "config_unsupported",
      `Provider '${input.provider}' options ${unsafe.sort().join(", ")} are not allowed on a tool-free agent`,
      input.provider,
    );
  }
}

/**
 * Claude Code expands a slash command from the last content block of a user message, and a
 * command can act without the model. `commandText` is that block as it will be sent; any text
 * there that starts with `/` is refused, whether or not Claude Code knows the command.
 */
export function assertClaudeToolFreePrompt(input: {
  provider: string;
  commandText: string | null;
}): void {
  if (input.commandText?.trimStart().startsWith("/")) {
    throw new ToolFreeAgentError(
      "config_unsupported",
      "A tool-free agent does not take slash commands; send the text without a leading '/'",
      input.provider,
    );
  }
}

const DENY_REASON = "This agent runs without tools.";

async function denyEveryToolHook() {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: DENY_REASON,
    },
  };
}

async function denyEveryToolPermission() {
  return { behavior: "deny" as const, message: DENY_REASON };
}

/**
 * Narrows Claude Code options to an empty tool surface. The surface is what keeps tools from
 * running; the deny hook and permission handler only add depth and are not relied on.
 */
export function applyClaudeToolFreeOptions(options: ClaudeOptions): ClaudeOptions {
  const {
    mcpServers: _mcpServers,
    plugins: _plugins,
    agents: _agents,
    allowedTools: _allowedTools,
    extraArgs: _extraArgs,
    ...rest
  } = options;
  const hooks = options.hooks ?? {};
  return {
    ...rest,
    tools: [],
    skills: [],
    strictMcpConfig: true,
    settingSources: [],
    settings: toolFreeFlagSettings(options.settings),
    canUseTool: denyEveryToolPermission,
    hooks: {
      ...hooks,
      PreToolUse: [{ hooks: [denyEveryToolHook], onFailure: "block" }, ...(hooks.PreToolUse ?? [])],
    },
  };
}

/**
 * Only the composer flags survive into a tool-free launch. A settings file or option can carry
 * hooks, permission rules or MCP switches, and none of those may reach the process.
 */
function toolFreeFlagSettings(settings: ClaudeOptions["settings"]): ClaudeOptions["settings"] {
  const source = typeof settings === "object" && settings !== null ? settings : {};
  return {
    ...(source.fastMode === undefined ? {} : { fastMode: source.fastMode }),
    ...(source.ultracode === undefined ? {} : { ultracode: source.ultracode }),
    disableClaudeAiConnectors: true,
    disableSkillShellExecution: true,
  };
}

/** The slice of the SDK Query the pre-prompt check reads. */
export interface ClaudeToolSurfaceProbe {
  initializationResult(): Promise<{
    hooks_applied?: boolean;
    hook_on_failure_supported?: boolean;
  }>;
  mcpServerStatus(): Promise<Array<{ name: string; status?: string }>>;
  getContextUsage(opts?: { detail?: "summary" | "full" }): Promise<{
    categories: Array<{ id?: string; name: string; tokens: number }>;
    mcpTools: Array<{ name: string }>;
    systemTools?: Array<{ name: string }>;
    deferredBuiltinTools?: Array<{ name: string }>;
  }>;
  /**
   * Present on the SDK's Query implementation but not in its published interface, so it is
   * optional here and its absence fails the check.
   */
  getHooksListing?: () => Promise<ClaudeHooksListing>;
}

/** The part of Claude Code's `get_hooks_listing` answer the check reads. */
export interface ClaudeHooksListing {
  hooks: Array<{ event: string; source: string; type?: string; disabled?: true }>;
  policy?: {
    managedOnly?: boolean;
    pluginOnly?: boolean;
    policyHookCount?: number;
    policyUnreadable?: true;
  };
}

/**
 * Hooks see the prompt, and managed policy hooks cannot be switched off from the launch. Claude
 * Code lists settings and plugin hooks and counts managed ones; the SDK's own callbacks are not
 * listed. Any listed hook, any managed hook, an unreadable policy, or a policy that hides managed
 * hooks from the listing fails the check.
 */
function hooksFailure(listing: ClaudeHooksListing): string | null {
  const policy = listing.policy;
  if (!policy) return "the hook policy was not reported";
  // Present at all means unreadable; the field has no false form.
  if (policy.policyUnreadable !== undefined) return "the managed settings could not be read";
  // Each field must be reported with its exact safe value. A missing one is not a zero.
  if (policy.managedOnly !== false || policy.pluginOnly !== false) {
    return "managed policy hides its hooks, or did not say";
  }
  if (policy.policyHookCount !== 0) {
    return `managed settings define ${policy.policyHookCount ?? "an unreported number of"} hook(s)`;
  }
  const running = listing.hooks.filter((hook) => hook.disabled !== true);
  if (running.length > 0) {
    return `hooks present: ${running.map((hook) => `${hook.event} (${hook.source})`).join(", ")}`;
  }
  return null;
}

function surfaceError(provider: string, detail: string): ToolFreeAgentError {
  return new ToolFreeAgentError(
    "surface_unverified",
    `Claude Code could not prove a tool-free session (${detail}); the prompt was not sent`,
    provider,
  );
}

/**
 * Asks the running Claude Code process for its tool surface before a prompt is sent. Any tool,
 * MCP server, unknown context row, or a CLI that cannot answer fails closed.
 */
export async function verifyClaudeToolFreeSurface(input: {
  provider: string;
  probe: ClaudeToolSurfaceProbe;
}): Promise<void> {
  const { provider, probe } = input;
  let init: Awaited<ReturnType<ClaudeToolSurfaceProbe["initializationResult"]>>;
  let servers: Awaited<ReturnType<ClaudeToolSurfaceProbe["mcpServerStatus"]>>;
  let usage: Awaited<ReturnType<ClaudeToolSurfaceProbe["getContextUsage"]>>;
  let hooks: ClaudeHooksListing;
  try {
    init = await probe.initializationResult();
    servers = await probe.mcpServerStatus();
    usage = await probe.getContextUsage({ detail: "summary" });
    if (typeof probe.getHooksListing !== "function") {
      throw new Error("this Claude Code SDK cannot list hooks");
    }
    hooks = await probe.getHooksListing();
  } catch (error) {
    throw surfaceError(
      provider,
      `tool surface query failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (init.hooks_applied !== true || init.hook_on_failure_supported !== true) {
    throw surfaceError(provider, "the deny-all tool hook was not registered");
  }
  const hookProblem = hooksFailure(hooks);
  if (hookProblem) throw surfaceError(provider, hookProblem);
  if (servers.length > 0) {
    throw surfaceError(provider, `MCP servers present: ${servers.map((s) => s.name).join(", ")}`);
  }
  const tools = [
    ...usage.mcpTools.map((tool) => tool.name),
    ...(usage.systemTools ?? []).map((tool) => tool.name),
    ...(usage.deferredBuiltinTools ?? []).map((tool) => tool.name),
  ];
  if (tools.length > 0) {
    throw surfaceError(provider, `tools present: ${tools.join(", ")}`);
  }
  const unexpected = usage.categories.filter(
    (category) => category.tokens > 0 && !TOOL_FREE_CONTEXT_CATEGORY_IDS.has(category.id ?? ""),
  );
  if (unexpected.length > 0) {
    throw surfaceError(
      provider,
      `context carries ${unexpected.map((category) => category.id ?? category.name).join(", ")}`,
    );
  }
}
