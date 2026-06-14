import {
  type AgentHookConfigFormat,
  buildAgentHookShellCommand,
  buildAgentHookWindowsCommand,
} from "../agent-hook-installer.js";

interface CodexCommandHook {
  type?: unknown;
  command?: unknown;
  commandWindows?: unknown;
  command_windows?: unknown;
  timeout?: unknown;
}

interface CodexMatcherGroup {
  matcher?: unknown;
  hooks?: unknown;
}

export interface CodexHooksFile {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

export const codexHooksFormat: AgentHookConfigFormat<CodexHooksFile> = {
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
      const userEntries = removePaseoHooks(hooks[event.event], install.hookMarker);
      hooks[event.event] = [
        ...userEntries,
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: buildAgentHookShellCommand(provider, event),
              commandWindows: buildAgentHookWindowsCommand(provider, event),
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
      const entries = removePaseoHooks(hooks[event.event], install.hookMarker);
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
        normalizeCommandHooks(entry.hooks).some((hook) =>
          hasPaseoCommands(hook, install.hookMarker),
        ),
      ),
    );
  },
};

function normalizeHooks(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function normalizeMatchers(value: unknown): CodexMatcherGroup[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

function normalizeCommandHooks(value: unknown): CodexCommandHook[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

function removePaseoHooks(value: unknown, marker: string): CodexMatcherGroup[] {
  const entries: CodexMatcherGroup[] = [];
  for (const entry of normalizeMatchers(value)) {
    const hooks = normalizeCommandHooks(entry.hooks).filter(
      (hook) => !commandContainsMarker(hook, marker),
    );
    if (hooks.length > 0) {
      entries.push(Object.assign({}, entry, { hooks }));
    }
  }
  return entries;
}

function hasPaseoCommands(hook: CodexCommandHook, marker: string): boolean {
  return (
    commandFieldContainsMarker(hook.command, marker) && windowsCommandContainsMarker(hook, marker)
  );
}

function commandContainsMarker(hook: CodexCommandHook, marker: string): boolean {
  return (
    commandFieldContainsMarker(hook.command, marker) || windowsCommandContainsMarker(hook, marker)
  );
}

function windowsCommandContainsMarker(hook: CodexCommandHook, marker: string): boolean {
  return (
    commandFieldContainsMarker(hook.commandWindows, marker) ||
    commandFieldContainsMarker(hook.command_windows, marker)
  );
}

function commandFieldContainsMarker(value: unknown, marker: string): boolean {
  return typeof value === "string" && value.includes(marker);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
