import {
  type AgentHookActivityState,
  type AgentHookConfigFormat,
  type AgentHookProvider,
  buildAgentHookShellCommand,
} from "../agent-hook-installer.js";

export interface CopilotHooksFile {
  version?: unknown;
  hooks?: unknown;
  [key: string]: unknown;
}

const events = ["userPromptSubmitted", "agentStop"] as const;
const states: Record<string, AgentHookActivityState> = {
  userPromptSubmitted: "running",
  agentStop: "idle",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hookEntries(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid Copilot hook entries");
  return value;
}

function powershellCommand(event: string): string {
  return `if ($env:PASEO_TERMINAL_ID) { if ($env:PASEO_HOOK_CLI) { & $env:PASEO_HOOK_CLI hooks copilot ${event} } else { & paseo hooks copilot ${event} } }`;
}

function isPaseoHook(
  value: unknown,
  provider: AgentHookProvider<CopilotHooksFile>,
  event: { event: string },
): boolean {
  return (
    isRecord(value) &&
    value.type === "command" &&
    value.bash === buildAgentHookShellCommand(provider, event) &&
    value.powershell === powershellCommand(event.event)
  );
}

const format: AgentHookConfigFormat<CopilotHooksFile> = {
  empty: () => ({ version: 1, hooks: {} }),
  parse(raw) {
    const config: unknown = JSON.parse(raw);
    if (!isRecord(config) || config.version !== 1 || !isRecord(config.hooks)) {
      throw new Error("Invalid Copilot hooks configuration");
    }
    return config;
  },
  stringify: (config) => `${JSON.stringify(config, null, 2)}\n`,
  install(config, provider) {
    if (!isRecord(config.hooks)) throw new Error("Invalid Copilot hooks configuration");
    const hooks = { ...config.hooks };
    for (const event of provider.events) {
      hooks[event.event] = [
        ...hookEntries(hooks[event.event]).filter((entry) => !isPaseoHook(entry, provider, event)),
        {
          type: "command",
          bash: buildAgentHookShellCommand(provider, event),
          powershell: powershellCommand(event.event),
          timeoutSec: 10,
        },
      ];
    }
    return { ...config, hooks };
  },
  uninstall(config, provider) {
    if (!isRecord(config.hooks)) throw new Error("Invalid Copilot hooks configuration");
    const hooks = { ...config.hooks };
    for (const event of provider.events) {
      const entries = hookEntries(hooks[event.event]).filter(
        (entry) => !isPaseoHook(entry, provider, event),
      );
      if (entries.length) hooks[event.event] = entries;
      else delete hooks[event.event];
    }
    return { ...config, hooks };
  },
  isInstalled(config, provider) {
    if (!isRecord(config.hooks)) return false;
    const hooks = config.hooks;
    return provider.events.every((event) =>
      hookEntries(hooks[event.event]).some((entry) => isPaseoHook(entry, provider, event)),
    );
  },
};

export const copilotAgentHookProvider: AgentHookProvider<CopilotHooksFile> = {
  id: "copilot",
  events: events.map((event) => ({ event })),
  install: {
    kind: "config-file",
    configDir: ".copilot",
    configFile: "hooks/paseo-terminal-activity.json",
    configDirEnvOverride: "COPILOT_HOME",
    hookMarker: "hooks copilot",
    format,
  },
  async resolveActivity({ event }) {
    return states[event] ?? null;
  },
};
