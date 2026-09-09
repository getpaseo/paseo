import {
  type AgentHookConfigFormat,
  buildAgentHookShellCommand,
  buildAgentHookWindowsPowerShellCommand,
} from "../agent-hook-installer.js";

interface ClaudeCommandHook {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
}

interface ClaudeHookMatcher {
  matcher?: unknown;
  hooks?: unknown;
}

export interface ClaudeSettings {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

export const claudeSettingsFormat: AgentHookConfigFormat<ClaudeSettings> = {
  empty() {
    return {};
  },
  parse(raw) {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    return parsed;
  },
  stringify(config) {
    return `${JSON.stringify(config, null, 2)}\n`;
  },
  install(config, provider) {
    const install = provider.install;
    const hooks = normalizeHooks(config.hooks);
    for (const event of provider.events) {
      const expectedCommand =
        process.platform === "win32"
          ? buildAgentHookWindowsPowerShellCommand(provider, event)
          : undefined;
      const userEntries = removePaseoHooks(hooks[event.event], install.hookMarker, expectedCommand);
      const hookCommand = expectedCommand ?? buildAgentHookShellCommand(provider, event);
      hooks[event.event] = [
        ...userEntries,
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: hookCommand,
              timeout: 10,
            },
          ],
        },
      ];
    }
    return { ...config, hooks };
  },
  uninstall(config, provider) {
    const install = provider.install;
    const hooks = normalizeHooks(config.hooks);
    for (const event of provider.events) {
      const expectedCommand =
        process.platform === "win32"
          ? buildAgentHookWindowsPowerShellCommand(provider, event)
          : undefined;
      const entries = removePaseoHooks(hooks[event.event], install.hookMarker, expectedCommand);
      if (entries.length > 0) {
        hooks[event.event] = entries;
      } else {
        delete hooks[event.event];
      }
    }
    return { ...config, hooks };
  },
  isInstalled(config, provider) {
    const install = provider.install;
    const hooks = normalizeHooks(config.hooks);
    return provider.events.every((event) =>
      normalizeMatchers(hooks[event.event]).some((entry) =>
        normalizeCommandHooks(entry.hooks).some((hook) => {
          const expectedCommand =
            process.platform === "win32"
              ? buildAgentHookWindowsPowerShellCommand(provider, event)
              : undefined;
          return commandContainsMarker(hook, install.hookMarker, expectedCommand);
        }),
      ),
    );
  },
};

function normalizeHooks(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function normalizeMatchers(value: unknown): ClaudeHookMatcher[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

function normalizeCommandHooks(value: unknown): ClaudeCommandHook[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

function removePaseoHooks(
  value: unknown,
  marker: string,
  expectedCommand: string | undefined,
): ClaudeHookMatcher[] {
  const entries: ClaudeHookMatcher[] = [];
  for (const entry of normalizeMatchers(value)) {
    const hooks = normalizeCommandHooks(entry.hooks).filter(
      (hook) => !commandContainsMarker(hook, marker, expectedCommand),
    );
    if (hooks.length > 0) {
      entries.push(Object.assign({}, entry, { hooks }));
    }
  }
  return entries;
}

function commandContainsMarker(
  hook: ClaudeCommandHook,
  marker: string,
  expectedCommand: string | undefined,
): boolean {
  if (typeof hook.command !== "string") {
    return false;
  }
  return hook.command.includes(marker) || hook.command === expectedCommand;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
