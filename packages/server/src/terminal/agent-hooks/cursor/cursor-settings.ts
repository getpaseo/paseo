import { type AgentHookConfigFormat, buildAgentHookShellCommand } from "../agent-hook-installer.js";

interface CursorCommandHook {
  command?: unknown;
  [key: string]: unknown;
}

export interface CursorHooksFile {
  version?: unknown;
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

export const cursorHooksFormat: AgentHookConfigFormat<CursorHooksFile> = {
  empty() {
    return { version: 1, hooks: {} };
  },
  parse(raw) {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return { version: 1, hooks: {} };
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
          command: buildAgentHookShellCommand(provider, event),
        },
      ];
    }
    return {
      ...config,
      version: typeof config.version === "number" ? config.version : 1,
      hooks,
    };
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
    return {
      ...config,
      version: typeof config.version === "number" ? config.version : 1,
      hooks,
    };
  },
  isInstalled(config, provider) {
    const install = provider.install;
    const hooks = normalizeHooks(config.hooks);
    return provider.events.every((event) =>
      normalizeCommandHooks(hooks[event.event]).some((hook) =>
        commandContainsMarker(hook, install.hookMarker),
      ),
    );
  },
};

function normalizeHooks(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function normalizeCommandHooks(value: unknown): CursorCommandHook[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

function removePaseoHooks(value: unknown, marker: string): CursorCommandHook[] {
  return normalizeCommandHooks(value).filter((hook) => !commandContainsMarker(hook, marker));
}

function commandContainsMarker(hook: CursorCommandHook, marker: string): boolean {
  return typeof hook.command === "string" && hook.command.includes(marker);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
