import {
  type AgentHookConfigFormat,
  type AgentHookEventDefinition,
  type AgentHookProvider,
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
      const expectedCommand = buildClaudeHookCommand(provider, event);
      const userEntries = removePaseoHooks(
        hooks[event.event],
        install.hookMarker,
        buildAgentHookWindowsPowerShellCommand(provider, event),
      );
      hooks[event.event] = [
        ...userEntries,
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: expectedCommand,
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
      const expectedCommand = buildAgentHookWindowsPowerShellCommand(provider, event);
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
    return provider.events.every((event) => {
      const expectedCommand = buildAgentHookWindowsPowerShellCommand(provider, event);
      return normalizeMatchers(hooks[event.event]).some((entry) =>
        normalizeCommandHooks(entry.hooks).some((hook) =>
          commandContainsMarker(hook, install.hookMarker, expectedCommand),
        ),
      );
    });
  },
};

function buildClaudeHookCommand(
  provider: AgentHookProvider<ClaudeSettings>,
  event: AgentHookEventDefinition,
): string {
  return process.platform === "win32"
    ? buildAgentHookWindowsPowerShellCommand(provider, event)
    : buildAgentHookShellCommand(provider, event);
}

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
  expectedCommand: string,
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
  expectedCommand: string,
): boolean {
  if (typeof hook.command !== "string") {
    return false;
  }
  if (hook.command.includes(marker) || hook.command === expectedCommand) {
    return true;
  }
  const script = decodeManagedPowerShellCommand(hook.command);
  if (script === null) {
    return false;
  }
  const identity = `# Paseo managed hook: ${marker}\n`;
  // Identity survives wrapper changes; only our exact PowerShell invocation is decoded.
  if (script.startsWith(identity)) {
    return true;
  }
  // Retain detection of the original, unmarked encoded wrapper on Windows.
  const expectedScript = decodeManagedPowerShellCommand(expectedCommand);
  return expectedScript !== null && script === expectedScript.slice(identity.length);
}

function decodeManagedPowerShellCommand(command: string): string | null {
  const match =
    /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/]+={0,2})$/.exec(
      command,
    );
  if (!match) {
    return null;
  }
  const payload = Buffer.from(match[1]!, "base64");
  if (payload.length % 2 !== 0 || payload.toString("base64") !== match[1]) {
    return null;
  }
  return payload.toString("utf16le");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
